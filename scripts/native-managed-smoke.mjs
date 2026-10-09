import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const bffPackage = resolve(process.env.PRIME_BFF_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/bff', import.meta.url)));
const adapterPackage = resolve(process.env.PRIME_ADAPTER_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/adapter', import.meta.url)));
const { BwrapPrimeContainedWorker, attestedPathDigest } = await import(pathToFileURL(join(bffPackage, 'dist/prime-runs/bwrap-prime-worker.js')));
const { PrimeRunRepository } = await import(pathToFileURL(join(bffPackage, 'dist/prime-runs/prime-run-repository.js')));
const { openDatabase } = await import(pathToFileURL(join(bffPackage, 'dist/store/database.js')));
const { primeCanonicalDigest, sha256Text, parsePrimeRunRequest } = await import(pathToFileURL(join(adapterPackage, 'dist/index.js')));
import { finalAuthority, launch } from '../packages/bff/test/prime-test-authority.ts';

// Real compiled Prime, real bubblewrap, real Python, real ACP/IPC and SQLite.
// Only the provider/accounting and host-governed API are controlled fixtures.
const runtimeRoot = process.argv[2];
assert(runtimeRoot && isAbsolute(runtimeRoot) && resolve(runtimeRoot) === runtimeRoot,
  'Usage: npm run qualify:native -- ABSOLUTE_NORMALIZED_ASSEMBLED_RUNTIME_ROOT');
process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), 'prime-native-'));
const workspace = join(root, 'workspace');
const privateRoot = join(root, 'private');
const ipcRoot = join(root, 'ipc');
await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(privateRoot, { mode: 0o700 }), mkdir(ipcRoot, { mode: 0o700 })]);
await writeFile(join(privateRoot, 'canary'), 'HOST_PRIVATE_CANARY');
const instruction = 'Use only the assigned Python tool. This is a controlled transport qualification, not a subscription call.';
const instructionPath = join(workspace, 'AGENTS.md');
await writeFile(instructionPath, instruction);
const db = openDatabase(join(root, 'state.sqlite'));
const repository = new PrimeRunRepository(db);
const executable = join(runtimeRoot, 'prime-agent');
const worker = new BwrapPrimeContainedWorker({
  executable, executableSha256: await attestedPathDigest(executable),
  runtimeRoot, runtimeSha256: await attestedPathDigest(runtimeRoot),
  ipcRoot, privatePaths: [privateRoot], repository,
});
const namespace = sha256Text(randomUUID());
const schema = { type: 'object', properties: { code: { type: 'string', description: "Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports." } }, required: ['code'] };
function request(runId, previous = null) {
  const authority = finalAuthority({
    operationId: runId, turnId: runId,
    identity: { ...finalAuthority().identity, runId },
    workspace: { ...finalAuthority().workspace, root: workspace, realRoot: workspace },
    instructions: { content: instruction, revision: null, sourcePath: instructionPath, sha256: sha256Text(instruction) },
    prompt: previous ? 'Resume the committed native journal.' : 'Run the controlled Python scenario.\n' + '界'.repeat(400_000),
    localTools: [{ name: 'ipython', policy: 'workspace-write', inputSchema: schema, schemaSha256: primeCanonicalDigest(schema) }],
    mcp: { setDigest: primeCanonicalDigest([]), gatewayId: null, assignmentDigest: null, tools: [] },
    session: { namespace, previous: previous ? { runId: previous.runId, primeSessionId: previous.primeSessionId,
      checkpoint: previous.checkpoint, checkpointDigest: previous.checkpointDigest, lastReceiptId: previous.lastReceiptId } : null },
    executeDeadlineAt: new Date(Date.now() + 90_000).toISOString(),
    controlDeadlineAt: new Date(Date.now() + 180_000).toISOString(),
  });
  const value = launch(authority);
  value.previousSession = previous;
  return parsePrimeRunRequest(value);
}
const cells = [
  `import json, os, sys, socket\nfrom pathlib import Path\ncounter = 41\nprobe = {"counter": counter, "private_visible": Path(${JSON.stringify(join(privateRoot, 'canary'))}).exists(), "credential_present": "OPENAI_API_KEY" in os.environ, "prefix": sys.prefix}\ns = socket.socket()\ns.settimeout(1)\ntry:\n    s.connect(("1.1.1.1", 443))\n    probe["network"] = "connected"\nexcept OSError as exc:\n    probe["network"] = type(exc).__name__\nfinally:\n    s.close()\nPath("kernel-proof.json").write_text(json.dumps(probe))\nprint(json.dumps(probe))`,
  `assert counter == 41\ncounter += 1\nfrom rlm import paperclip\ncomment = await paperclip.request("POST", "/api/issues/issue-1/comments", {"body": "native-bridge-smoke"})\nintent = await paperclip.finish("in_review", "Native controlled smoke completed")\nPath("persistence-proof.json").write_text(json.dumps({"counter": counter, "comment": comment, "intent": intent}))\nprint("PERSISTENT_COUNTER", counter)`,
];
let providerCalls = 0;
const providerRequests = [];
const governed = [];
const fenced = new Set();
async function* broker(input, purpose) {
  const payload = input.payload;
  let sequence = 0;
  const result = (value) => ({ version: 2, requestId: input.requestId, sequence: sequence++, kind: 'result', result: value });
  console.log(JSON.stringify({ broker: payload.method, purpose, requestId: input.requestId }));
  if (payload.method === 'provider.catalog') {
    yield result({ kind: 'catalog', provider: 'openai-codex', model: 'gpt-6.1-sol', available: true });
  } else if (payload.method === 'provider.stream') {
    assert.equal(payload.request.model, 'gpt-6.1-sol');
    providerCalls++;
    providerRequests.push(payload.request);
    await writeFile(join(root, `provider-${providerCalls}.json`), JSON.stringify(payload.request));
    const id = `response-${providerCalls}`;
    const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } };
    const event = (value) => ({ version: 2, requestId: input.requestId, sequence: sequence++, kind: 'provider_event', event: value });
    yield event({ type: 'response.created', response: { id, status: 'in_progress' } });
    let output;
    if (providerCalls <= cells.length) {
      const item = { type: 'function_call', id: `fc-${providerCalls}`, call_id: `call-${providerCalls}`, name: 'ipython', arguments: JSON.stringify({ code: cells[providerCalls - 1] }), status: 'completed' };
      yield event({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
      yield event({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments });
      yield event({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments });
      yield event({ type: 'response.output_item.done', output_index: 0, item });
      output = [item];
    } else {
      const text = providerCalls === 3 ? 'SESSION_A_DONE' : 'SESSION_B_DONE';
      const item = { type: 'message', id: `msg-${providerCalls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      yield event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      yield event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      yield event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text });
      yield event({ type: 'response.output_item.done', output_index: 0, item });
      output = [item];
    }
    yield event({ type: 'response.completed', response: { id, status: 'completed', output, usage } });
    yield result({ kind: 'provider', providerRequestId: id, state: 'completed', usage });
  } else if (payload.method === 'paperclip.request') {
    governed.push(payload);
    assert.equal(payload.httpMethod, 'POST');
    assert.equal(payload.path, '/api/issues/issue-1/comments');
    yield result({ kind: 'paperclip', requestId: input.requestId, status: 201, body: { id: 'comment-1' } });
  } else if (payload.method === 'paperclip.finish') {
    governed.push(payload);
    yield result({ kind: 'finalization', intentId: input.requestId, issueId: 'issue-1', status: payload.status, summary: payload.summary, state: 'recorded' });
  } else if (payload.method === 'operation.status' || payload.method === 'operation.stop') {
    if (payload.method === 'operation.stop') fenced.add(input.operationId);
    yield result({ kind: 'operation', fenced: fenced.has(input.operationId), provider: 'settled', governedActions: 'settled', outstandingEffects: 0 });
  } else {
    throw new Error(`Unplanned broker method ${payload.method}`);
  }
}
async function run(req) {
  repository.admit(req);
  const events = [];
  for await (const event of worker.execute(req, AbortSignal.timeout(120_000), broker)) {
    repository.append(req, event);
    events.push(event);
    console.log(JSON.stringify({ event: event.type, sequence: event.sequence, ...event }));
  }
  await writeFile(join(root, `${req.operationId}-events.json`), JSON.stringify(events, null, 2));
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'terminal');
  assert.equal(terminal.outcome, 'completed');
  assert.equal(terminal.settlement.provider, 'settled');
  assert.equal(terminal.settlement.worker, 'stopped');
  assert.equal(terminal.settlement.descendants, 'stopped');
  assert.equal(terminal.settlement.governedActions, 'settled');
  assert(terminal.session.checkpoint && terminal.session.checkpointDigest);
  return terminal;
}
console.log(JSON.stringify({ qualification: 'real native worker; controlled provider only', root, runtimeRoot }));
const originalCredential = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'synthetic-isolation-marker-not-a-credential';
try {
  const first = await run(request('smoke-a'));
  assert.equal(providerCalls, 3);
  assert.deepEqual(first.usage, { inputTokens: 60, outputTokens: 15, cachedInputTokens: 0 });
  const kernel = JSON.parse(await readFile(join(workspace, 'kernel-proof.json'), 'utf8'));
  assert.equal(kernel.private_visible, false);
  assert.equal(kernel.credential_present, false);
  assert.notEqual(kernel.network, 'connected');
  assert.equal(kernel.prefix, '/opt/paperclip/runtime/kernel-env');
  const persistent = JSON.parse(await readFile(join(workspace, 'persistence-proof.json'), 'utf8'));
  assert.equal(persistent.counter, 42);
  assert.equal(governed.length, 2);
  assert.equal(first.finalization.status, 'in_review');
  const second = await run(request('smoke-b', first.session));
  assert.equal(providerCalls, 4);
  assert.equal(second.session.primeSessionId, first.session.primeSessionId);
  assert(JSON.stringify(providerRequests[3]).includes('SESSION_A_DONE'));
  assert.equal(Buffer.byteLength(JSON.stringify(providerRequests[0])) > 1_048_576, true);
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ kind: 'controlled-broker-real-native', runtimeRoot,
    providerCalls, kernel, withinRunCounter: persistent.counter, nativeSessionId: second.session.primeSessionId,
    checkpointCommitted: true, journalResumed: true, governedBridgeCalls: governed.length,
    requestBytes: Buffer.byteLength(JSON.stringify(providerRequests[0])) }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: join(root, 'evidence.json') }));
} finally {
  if (originalCredential === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalCredential;
  db.close();
}
