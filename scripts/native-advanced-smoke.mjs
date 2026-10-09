import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const bffPackage = resolve(process.env.PRIME_BFF_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/bff', import.meta.url)));
const adapterPackage = resolve(process.env.PRIME_ADAPTER_PACKAGE_DIR ?? fileURLToPath(new URL('../packages/adapter', import.meta.url)));
const { BwrapPrimeContainedWorker, attestedPathDigest } = await import(pathToFileURL(join(bffPackage, 'dist/prime-runs/bwrap-prime-worker.js')));
const { PrimeRunRepository } = await import(pathToFileURL(join(bffPackage, 'dist/prime-runs/prime-run-repository.js')));
const { openDatabase } = await import(pathToFileURL(join(bffPackage, 'dist/store/database.js')));
const { primeCanonicalDigest, sha256Text, parsePrimeRunRequest } = await import(pathToFileURL(join(adapterPackage, 'dist/index.js')));
import { finalAuthority, launch } from '../packages/bff/test/prime-test-authority.ts';

// Run one isolated scenario per invocation against an explicitly supplied assembled runtime.
const [runtimeRoot, scenario] = process.argv.slice(2);
assert(runtimeRoot && isAbsolute(runtimeRoot) && resolve(runtimeRoot) === runtimeRoot &&
  ['child', 'compaction', 'threshold', 'mcp', 'uncertain', 'hostile', 'hostile-git'].includes(scenario),
  'Usage: npm run qualify:native:advanced -- ABSOLUTE_NORMALIZED_ASSEMBLED_RUNTIME_ROOT child|compaction|threshold|mcp|uncertain|hostile|hostile-git');
process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), `prime-advanced-${scenario}-`));
const workspace = join(root, 'workspace');
const privateRoot = join(root, 'private');
const ipcRoot = join(root, 'ipc');
await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(privateRoot, { mode: 0o700 }), mkdir(ipcRoot, { mode: 0o700 })]);
const instruction = 'Controlled disposable native qualification. Only use assigned tools.';
const instructionPath = join(workspace, 'AGENTS.md');
await writeFile(instructionPath, instruction);
const executable = join(runtimeRoot, 'prime-agent');
const binaryDigest = await attestedPathDigest(executable);
const runtimeDigest = await attestedPathDigest(runtimeRoot);
const db = openDatabase(join(root, 'state.sqlite'));
const repository = new PrimeRunRepository(db);
const worker = new BwrapPrimeContainedWorker({ executable, executableSha256: binaryDigest, runtimeRoot, runtimeSha256: runtimeDigest, ipcRoot, privatePaths: [privateRoot], repository });
const schema = { type: 'object', properties: { code: { type: 'string', description: "Python code to execute in the persistent Python REPL. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports." } }, required: ['code'] };
const tools = ['search', 'write', 'reject', 'denied'].map((name, n) => ({ connectionId: 'connection-1', name, description: name, inputSchema: { type: 'object' }, schemaSha256: primeCanonicalDigest({ type: 'object' }), policy: ['allow', 'approval', 'approval', 'deny'][n] }));
const mcpName = (name) => `mcp_${createHash('sha256').update('connection-1').update('\0').update(name).digest('hex').slice(0, 32)}`;
const evidence = { scenario, root, workspace, runtimeRoot, binaryDigest, runtimeDigest, qualification: 'compiled Prime/Python/SQLite/bwrap; provider and MCP broker are controlled fixtures, not live provider', broker: [], effects: [], provider: [], events: [], checks: {} };
const runId = `advanced-${scenario}-${randomUUID()}`;
const authority = finalAuthority({ operationId: runId, turnId: runId,
  identity: { ...finalAuthority().identity, runId },
  workspace: { ...finalAuthority().workspace, root: workspace, realRoot: workspace },
  instructions: { content: instruction, revision: null, sourcePath: instructionPath, sha256: sha256Text(instruction) },
  prompt: `Execute controlled ${scenario} scenario.` + (scenario === 'compaction' ? '\n' + '界'.repeat(160_000) : scenario === 'threshold' ? '\n' + '界'.repeat(670_000) : ''),
  localTools: [{ name: 'ipython', policy: 'workspace-write', inputSchema: schema, schemaSha256: primeCanonicalDigest(schema) }],
  mcp: scenario === 'mcp' || scenario === 'uncertain' ? { setDigest: primeCanonicalDigest(tools), gatewayId: 'gateway-1', assignmentDigest: 'a'.repeat(64), tools } : { setDigest: primeCanonicalDigest([]), gatewayId: null, assignmentDigest: null, tools: [] },
  session: { namespace: sha256Text(randomUUID()), previous: null },
  executeDeadlineAt: new Date(Date.now() + 110_000).toISOString(),
  controlDeadlineAt: new Date(Date.now() + 200_000).toISOString(),
});
const req = parsePrimeRunRequest(launch(authority));
const py = (code) => ({ name: 'ipython', args: { code } });
const call = (name, args) => ({ name, args });
const hostileProof = join(privateRoot, 'outside-marker');
if (scenario === 'hostile' || scenario === 'hostile-git') {
  await mkdir(join(workspace, '.git', 'hooks'), { recursive: true });
  await writeFile(join(workspace, '.git', 'config'), `[core]\n  hooksPath = ${join(workspace, '.git', 'hooks')}\n[alias]\n  qualifyprobe = !sh -c 'echo GIT_ESCAPED > ${hostileProof}'\n`);
  await writeFile(join(workspace, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho HOOK_RAN > ${join(workspace, 'hook-inside-proof')}\necho HOOK_ESCAPED > ${hostileProof}\nexit 0\n`, { mode: 0o755 });
}
if (scenario === 'hostile') {
  await writeFile(join(workspace, 'rlm.py'), `from pathlib import Path\nPath(${JSON.stringify(hostileProof)}).write_text('PY_IMPORT_ESCAPED')\nraise RuntimeError('malicious workspace rlm.py imported')\n`);
  await writeFile(join(workspace, 'sitecustomize.py'), `from pathlib import Path\nPath(${JSON.stringify(hostileProof)}).write_text('SITE_ESCAPED')\n`);
}
const plans = {
  child: {
    root: [py(`import json\nfrom pathlib import Path\na = await rlm.spawn('ADV_CHILD_A: spawn ADV_GRAND_A then report', name='child-a')\nb = await rlm.spawn('ADV_CHILD_B: spawn ADV_GRAND_B then report', name='child-b')\nPath('root-child-handles.json').write_text(json.dumps({'names':[a.name,b.name],'ids':[a.rlm_child_id,b.rlm_child_id]}))\nprint('ROOT_ADMITTED',a.name,b.name)`), py(`import json\nfrom pathlib import Path\nrows = await rlm.collect(timeout_ms=45000)\nPath('root-child-collect.json').write_text(json.dumps([{'name':r.session_name,'status':r.status,'settled':r.settled,'error':r.error} for r in rows]))\nprint('ROOT_COLLECT', [(r.session_name,r.status,r.settled) for r in rows])`), py(`from pathlib import Path\ntry:\n    await rlm.spawn('must not run after total four', name='fifth-rejected')\nexcept Exception as exc:\n    Path('total-four-boundary').write_text(str(exc))\nelse:\n    raise AssertionError('fifth child admitted')`)],
    childA: [py(`from pathlib import Path\ng = await rlm.spawn('ADV_GRAND_A: check depth boundary', name='grand-a')\nPath('child-a-proof').write_text(g.name)\nprint('CHILD_A_ADMITTED',g.name)`) ],
    childB: [py(`from pathlib import Path\ng = await rlm.spawn('ADV_GRAND_B: check depth boundary', name='grand-b')\nPath('child-b-proof').write_text(g.name)\nprint('CHILD_B_ADMITTED',g.name)`) ],
    grandA: [py(`from pathlib import Path\ntry:\n    await rlm.spawn('must not exist', name='depth-3-rejected')\nexcept Exception as exc:\n    Path('grand-a-boundary').write_text(str(exc))\nelse:\n    raise AssertionError('depth three admitted')`) ],
    grandB: [py(`from pathlib import Path\ntry:\n    await rlm.spawn('must not exist', name='depth-3-rejected-b')\nexcept Exception as exc:\n    Path('grand-b-boundary').write_text(str(exc))\nelse:\n    raise AssertionError('depth three admitted')`) ],
  },
  compaction: { root: [py(`from pathlib import Path\nPath('pre-compaction-proof').write_text('first cell committed')\n# ${'界'.repeat(100_000)}`), py(`from pathlib import Path\nfrom rlm import host_request\nreply = await host_request('compact.run', {'instructions':'Preserve the controlled compaction proof and exact outcome.'})\nPath('compaction-request-proof').write_text(str(reply))\nprint('COMPACT_REQUESTED',reply)`) ] },
  threshold: { root: [py(`import json\nfrom pathlib import Path\nfrom rlm import host_request\nPath('threshold-context.json').write_text(json.dumps(await host_request('compact.status', {})))\nPath('threshold-pre-proof').write_text('first cell committed')\n# ${'界'.repeat(110_000)}`)] },
  mcp: { root: [call(mcpName('search'), { query: 'approved-read' }), call(mcpName('write'), { body: 'approved-write' }), call(mcpName('reject'), { body: 'must-not-commit' }), py(`from pathlib import Path\nfrom rlm import host_request\ntry:\n    await host_request('mcp.tools.call', {'connectionId':'connection-1','tool':'denied','arguments':{}})\nexcept Exception as exc:\n    Path('denied-proof').write_text(type(exc).__name__ + ':' + str(exc))\nelse:\n    raise AssertionError('unassigned MCP direct request succeeded')`) ] },
  uncertain: { root: [call(mcpName('write'), { body: 'uncertain-do-not-repeat' })] },
  hostile: { root: [py(`import os, sys, json\nfrom pathlib import Path\nimport rlm\nprobe = {'rlm_module': getattr(rlm,'__file__',None), 'outside_visible': Path(${JSON.stringify(hostileProof)}).exists(), 'cwd':os.getcwd(), 'pythonpath':sys.path[:4]}\nPath('hostile-kernel-proof.json').write_text(json.dumps(probe))\nprint('HOSTILE_PROBE',json.dumps(probe))`) ] },
  'hostile-git': { root: [py(`import subprocess, json\nfrom pathlib import Path\nsubprocess.run(['git', 'init', '-q'], check=True)\na = subprocess.run(['git', 'qualifyprobe'], capture_output=True, text=True)\nb = subprocess.run(['git', '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--allow-empty', '-m', 'qualification'], capture_output=True, text=True)\nPath('git-contained-proof.json').write_text(json.dumps({'alias_return':a.returncode, 'commit_return':b.returncode, 'hook_ran':Path('hook-inside-proof').exists(), 'outside_visible':Path(${JSON.stringify(hostileProof)}).exists(), 'alias_stderr':a.stderr[-300:], 'hook_stderr':b.stderr[-300:]}))\nprint('GIT_CONTAINED',a.returncode,b.returncode)`) ] },
};
const counts = new Map();
let uncertainStarted;
const uncertainSeen = new Promise((resolve) => { uncertainStarted = resolve; });
const effectRequests = new Map();
let effectCalls = 0;
const committedEffects = [];
const fenced = new Set();
function group(request) {
  if (scenario !== 'child') return 'root';
  const text = JSON.stringify(request.input.filter((item) => item.role === 'user'));
  if (text.includes('ADV_CHILD_A')) return 'childA';
  if (text.includes('ADV_CHILD_B')) return 'childB';
  if (text.includes('ADV_GRAND_A')) return 'grandA';
  if (text.includes('ADV_GRAND_B')) return 'grandB';
  return 'root';
}
async function* broker(input, purpose) {
  const payload = input.payload;
  evidence.broker.push({ method: payload.method, purpose, requestId: input.requestId, ...(payload.tool ? { tool: payload.tool } : {}), ...(payload.targetRequestId ? { targetRequestId: payload.targetRequestId } : {}) });
  let sequence = 0;
  const result = (value) => ({ version: 2, requestId: input.requestId, sequence: sequence++, kind: 'result', result: value });
  const event = (value) => ({ version: 2, requestId: input.requestId, sequence: sequence++, kind: 'provider_event', event: value });
  if (payload.method === 'provider.catalog') { yield result({ kind: 'catalog', provider: 'openai-codex', model: 'gpt-6.1-sol', available: true }); return; }
  if (payload.method === 'provider.stream') {
    const request = payload.request;
    assert.equal(request.model, 'gpt-6.1-sol');
    const selected = group(request);
    const index = counts.get(selected) ?? 0;
    counts.set(selected, index + 1);
    evidence.provider.push({ turnId: payload.turnId, group: selected, index, toolNames: request.tools?.map((t) => t.name) ?? [], inputBytes: Buffer.byteLength(JSON.stringify(request.input)) });
    const id = `response-${randomUUID()}`;
    const usage = scenario === 'threshold' && request.tools?.length ? { input_tokens: index === 0 ? 670000 : 785000, output_tokens: 5, total_tokens: (index === 0 ? 670000 : 785000) + 5, input_tokens_details: { cached_tokens: 0 } } : { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } };
    yield event({ type: 'response.created', response: { id, status: 'in_progress' } });
    const selectedPlan = plans[scenario]?.[selected] ?? [];
    const next = selectedPlan[index];
    let item;
    if (next && request.tools?.some((t) => t.name === next.name)) {
      item = { type: 'function_call', id: `fc-${randomUUID()}`, call_id: `call-${randomUUID()}`, name: next.name, arguments: JSON.stringify(next.args), status: 'completed' };
      yield event({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
      yield event({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments });
      yield event({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments });
    } else {
      const text = request.tools?.length ? `DONE_${scenario}_${selected}_${index}` : 'Compaction summary: controlled request, preserved proof and exact outcome.';
      item = { type: 'message', id: `msg-${randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      yield event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      yield event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      yield event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: text });
    }
    yield event({ type: 'response.output_item.done', output_index: 0, item });
    yield event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage } });
    yield result({ kind: 'provider', providerRequestId: id, state: 'completed', usage });
    return;
  }
  if (payload.method === 'mcp.tools.call') {
    effectCalls++;
    assert(['search', 'write', 'reject'].includes(payload.tool));
    const value = { kind: 'effect', requestId: input.requestId, invocationId: `invocation-${effectCalls}`, actionRequestId: payload.tool === 'search' ? null : `action-${effectCalls}`, interactionId: null, formalApprovalId: null, argumentsHash: primeCanonicalDigest(payload.arguments), state: payload.tool === 'search' ? 'completed' : scenario === 'mcp' ? 'awaiting_approval' : 'uncertain', result: payload.tool === 'search' ? { found: true } : null };
    evidence.effects.push({ method: payload.method, tool: payload.tool, requestId: input.requestId, receipt: value });
    effectRequests.set(input.requestId, { tool: payload.tool, receipt: value });
    yield result(value);
    if (scenario === 'uncertain') uncertainStarted();
    return;
  }
  if (payload.method === 'effect.status') {
    assert.equal(scenario, 'mcp');
    const original = effectRequests.get(payload.targetRequestId);
    assert(original && ['write', 'reject'].includes(original.tool));
    const approved = original.tool === 'write';
    const receipt = { ...original.receipt, state: approved ? 'completed' : 'failed', result: approved ? { written: true } : null };
    if (approved) {
      committedEffects.push({ requestId: payload.targetRequestId, tool: original.tool, result: receipt.result });
      await writeFile(join(root, 'effect-side-effects.json'), JSON.stringify(committedEffects));
    }
    evidence.effects.push({ method: payload.method, targetRequestId: payload.targetRequestId, receipt });
    yield result(receipt);
    return;
  }
  if (payload.method === 'operation.stop' || payload.method === 'operation.status') {
    if (payload.method === 'operation.stop') fenced.add(input.operationId);
    const uncertain = scenario === 'uncertain';
    yield result({ kind: 'operation', fenced: fenced.has(input.operationId), provider: 'settled', governedActions: uncertain ? 'uncertain' : 'settled', outstandingEffects: uncertain ? 1 : 0 });
    return;
  }
  throw new Error(`Unplanned broker method ${payload.method}`);
}
const controller = new AbortController();
let passed = false;
try {
  repository.admit(req);
  const execute = (async () => {
    for await (const item of worker.execute(req, controller.signal, broker)) {
      repository.append(req, item);
      evidence.events.push(item);
    }
  })();
  if (scenario === 'uncertain') {
    await uncertainSeen;
    evidence.checks.cancelSettlement = await worker.cancel(req.operationId);
    assert.notEqual(evidence.checks.cancelSettlement, 'not_found');
    assert.equal(evidence.checks.cancelSettlement.worker, 'stopped');
    assert.equal(evidence.checks.cancelSettlement.descendants, 'stopped');
    assert.equal(evidence.checks.cancelSettlement.governedActions, 'uncertain');
    controller.abort();
  }
  await execute;
  const terminal = evidence.events.at(-1);
  assert.equal(terminal?.type, 'terminal');
  evidence.checks.terminal = terminal;
  if (scenario === 'uncertain') {
    assert.equal(effectCalls, 1);
    assert.equal(terminal.outcome, 'uncertain');
    assert.equal(terminal.settlement.governedActions, 'uncertain');
    assert.equal(evidence.broker.filter((x) => x.method === 'mcp.tools.call').length, 1);
    assert.equal(evidence.broker.filter((x) => x.method === 'operation.stop').length, 1);
    evidence.checks.writerLease = db.prepare('SELECT operation_id FROM prime_writer_leases WHERE operation_id = ?').get(req.operationId) !== undefined;
    assert(evidence.checks.writerLease);
    const blockedId = `excluded-${randomUUID()}`;
    const blockedAuthority = { ...authority, operationId: blockedId, turnId: blockedId, identity: { ...authority.identity, runId: blockedId } };
    const blockedRequest = parsePrimeRunRequest(launch(blockedAuthority));
    evidence.checks.writerExclusion = null;
    try { repository.admit(blockedRequest); }
    catch (error) { evidence.checks.writerExclusion = String(error); }
    assert(evidence.checks.writerExclusion?.includes('writer'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prime_run_operations WHERE operation_id = ?').get(blockedId).n, 0);
  } else {
    assert.equal(terminal.outcome, 'completed');
    assert.equal(terminal.settlement.provider, 'settled');
    assert.equal(terminal.settlement.worker, 'stopped');
    assert.equal(terminal.settlement.descendants, 'stopped');
    assert.equal(terminal.settlement.governedActions, 'settled');
    assert(terminal.session.checkpoint && terminal.session.checkpointDigest);
    const journalPath = join(ipcRoot, 'prime-native-checkpoints', terminal.session.checkpoint, 'session', `${terminal.session.primeSessionId}.jsonl`);
    evidence.checks.journalPath = journalPath;
    const nativeEntries = (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (scenario === 'child') {
      for (const name of ['root-child-handles.json', 'root-child-collect.json', 'child-a-proof', 'child-b-proof', 'grand-a-boundary', 'grand-b-boundary', 'total-four-boundary']) {
        evidence.checks[name] = await readFile(join(workspace, name), 'utf8');
      }
      assert.equal(JSON.parse(evidence.checks['root-child-handles.json']).names.length, 2);
      assert(JSON.parse(evidence.checks['root-child-collect.json']).every((row) => row.status === 'done' && row.settled && row.error === null));
      assert(evidence.checks['grand-a-boundary'].includes('depth limit'));
      assert(evidence.checks['grand-b-boundary'].includes('depth limit'));
      assert.equal(evidence.provider.filter((p) => p.group.startsWith('grand') && p.index === 0).length, 2);
      assert(evidence.checks['total-four-boundary'].includes('subagent limit'));
    }
    if (scenario === 'compaction') {
      evidence.checks.compactionProof = await readFile(join(workspace, 'compaction-request-proof'), 'utf8');
      assert(evidence.checks.compactionProof.includes("'scheduled': True"));
      const compacted = nativeEntries.find((entry) => entry.type === 'compaction');
      assert(compacted?.customInstructions === 'Preserve the controlled compaction proof and exact outcome.');
      evidence.checks.compactionEntry = { id: compacted.id, firstKeptEntryId: compacted.firstKeptEntryId, customInstructions: compacted.customInstructions };
      assert(evidence.provider.some((p) => p.toolNames.length === 0));
    }
    if (scenario === 'threshold') {
      assert.equal(await readFile(join(workspace, 'threshold-pre-proof'), 'utf8'), 'first cell committed');
      const compacted = nativeEntries.find((entry) => entry.type === 'compaction');
      assert(compacted && compacted.customInstructions === undefined);
      evidence.checks.compactionEntry = { id: compacted.id, firstKeptEntryId: compacted.firstKeptEntryId, tokensBefore: compacted.tokensBefore };
      assert(evidence.provider.some((p) => p.toolNames.length === 0));
    }
    if (scenario === 'mcp') {
      evidence.checks.deniedProof = await readFile(join(workspace, 'denied-proof'), 'utf8');
      assert.equal(effectCalls, 3);
      assert.deepEqual(evidence.effects.map((effect) => effect.receipt.state), ['completed', 'awaiting_approval', 'completed', 'awaiting_approval', 'failed']);
      assert.equal(evidence.effects[1].requestId, evidence.effects[2].targetRequestId);
      assert.equal(evidence.effects[3].requestId, evidence.effects[4].targetRequestId);
      assert.equal(evidence.effects[4].receipt.argumentsHash, primeCanonicalDigest({ body: 'must-not-commit' }));
      assert(evidence.checks.deniedProof.includes('not available in this session'));
      const toolResults = nativeEntries.filter((entry) => entry.type === 'message' && entry.message?.role === 'toolResult');
      assert(toolResults.some((entry) => JSON.stringify(entry.message.content).includes('written')));
      const rejected = toolResults.find((entry) => JSON.stringify(entry.message.content).includes('Managed MCP effect has no authoritative completed receipt'));
      assert(rejected?.message.isError === true);
      evidence.checks.rejectedNativeTool = { isError: rejected.message.isError, toolName: rejected.message.toolName, result: rejected.message.content };
      assert.equal(evidence.broker.filter((entry) => entry.method === 'effect.status').length, 2);
      assert.equal(evidence.broker.filter((entry) => entry.method === 'mcp.tools.call' && entry.tool === 'reject').length, 1);
      assert(!evidence.provider.some((provider) => provider.toolNames.includes(mcpName('denied'))));
      assert(!evidence.broker.some((entry) => entry.method === 'mcp.tools.call' && entry.tool === 'denied'));
      evidence.checks.committedEffects = JSON.parse(await readFile(join(root, 'effect-side-effects.json'), 'utf8'));
      assert.deepEqual(evidence.checks.committedEffects, [{ requestId: evidence.effects[1].requestId, tool: 'write', result: { written: true } }]);
      evidence.checks.writerLeaseReleased = db.prepare('SELECT operation_id FROM prime_writer_leases WHERE operation_id = ?').get(req.operationId) === undefined;
      assert.equal(evidence.checks.writerLeaseReleased, true);
    }
    if (scenario === 'hostile') {
      evidence.checks.outsideMarker = await stat(hostileProof).then(() => true, () => false);
      assert.equal(evidence.checks.outsideMarker, false);
      const kernelFailure = nativeEntries.find((entry) => entry.type === 'message' && entry.message?.role === 'toolResult' && JSON.stringify(entry.message.content).includes('Kernel exited before ready'));
      assert(kernelFailure && JSON.stringify(kernelFailure.message.content).includes(`${workspace}/rlm.py`));
      evidence.checks.containedImport = 'Workspace rlm.py executed only in contained Python and could not write the outside marker; kernel startup failed closed.';
    }
    if (scenario === 'hostile-git') {
      evidence.checks.git = JSON.parse(await readFile(join(workspace, 'git-contained-proof.json'), 'utf8'));
      evidence.checks.outsideMarker = await stat(hostileProof).then(() => true, () => false);
      assert.equal(evidence.checks.outsideMarker, false);
      assert.equal(evidence.checks.git.outside_visible, false);
      assert.equal(evidence.checks.git.hook_ran, true);
      assert.notEqual(evidence.checks.git.alias_return, 0);
      assert.equal(evidence.checks.git.commit_return, 0);
    }
  }
  passed = true;
} catch (error) {
  evidence.error = { message: String(error), stack: error?.stack };
} finally {
  evidence.passed = passed;
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  db.close();
}
console.log(JSON.stringify({ scenario, passed, evidence: join(root, 'evidence.json'), error: evidence.error?.message }));
if (!passed) process.exitCode = 1;
