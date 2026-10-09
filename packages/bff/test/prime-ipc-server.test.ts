import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrimeIpcMount } from "../src/prime-runs/prime-ipc-server.js";
import { BwrapPrimeContainedWorker } from "../src/prime-runs/bwrap-prime-worker.js";
import { PrimeRunRepository } from "../src/prime-runs/prime-run-repository.js";
import { openDatabase } from "../src/store/database.js";
import { AUTHORITY_DIGEST, finalAuthority, launch } from "./prime-test-authority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(broker: (request: { requestId: string }) => AsyncIterable<unknown>) {
  const root = await mkdtemp(join(tmpdir(), "prime-real-uds-"));
  roots.push(root);
  const db = openDatabase(join(root, "state.sqlite"));
  const repository = new PrimeRunRepository(db);
  const request = launch();
  repository.admit(request);
  const mount = await createPrimeIpcMount({ root, request, repository,
    broker: (input) => broker(input as { requestId: string }) });
  return { root, db, repository, mount };
}

function request(requestId: string, payload: object = { method: "provider.catalog" }) {
  return { version: 2, authorityDigest: AUTHORITY_DIGEST,
    operationId: "run-1", requestId, payload };
}

async function send(path: string, input: unknown): Promise<string> {
  const socket = connect(path);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => { socket.end(`${JSON.stringify(input)}\n`); resolve(); });
    socket.once("error", reject);
  });
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return Buffer.concat(chunks).toString("utf8");
}

describe("lifecycle-owned Unix socket broker boundary", () => {
  it("rejects overlong operation socket paths at worker construction, counting UTF-8 bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-ipc-root-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const repository = new PrimeRunRepository(db);
      for (const ipcRoot of [join("/tmp", "a".repeat(77)), join("/tmp", "é".repeat(39))]) {
        expect(() => new BwrapPrimeContainedWorker({
          executable: join(root, "runtime/prime-agent"),
          executableSha256: "0".repeat(64),
          runtimeRoot: join(root, "runtime"),
          runtimeSha256: "0".repeat(64),
          ipcRoot,
          privatePaths: [root],
          repository,
        })).toThrow("107-byte Unix socket path limit");
      }
    } finally {
      db.close();
    }
  });

  it("binds a real operation socket at the 107-byte pathname boundary", async () => {
    const parent = await mkdtemp(join(tmpdir(), "prime-ipc-boundary-"));
    roots.push(parent);
    const root = join(parent, "a".repeat(81 - Buffer.byteLength(parent) - 1));
    await mkdir(root, { mode: 0o700 });
    const db = openDatabase(join(parent, "state.sqlite"));
    const repository = new PrimeRunRepository(db);
    const request = launch();
    repository.admit(request);
    const mount = await createPrimeIpcMount({
      root, request, repository,
      broker: async function* () { throw new Error("boundary probe must not dispatch"); },
    });
    try {
      const socket = join(mount.directory, "ipc.sock");
      expect(Buffer.byteLength(socket)).toBe(107);
      expect((await lstat(socket)).isSocket()).toBe(true);
    } finally {
      await mount.close();
      db.close();
    }
  });

  it("binds one request to the assigned operation without leaking host capability in the manifest", async () => {
    let dispatched = 0;
    const { db, mount } = await fixture(async function* (input) {
      dispatched++;
      yield { version: 2, requestId: input.requestId, sequence: 0, kind: "result",
        result: { kind: "catalog", provider: "openai-codex", model: "gpt-6.1-sol", available: true } };
    });
    const manifest = await readFile(join(mount.directory, "manifest.json"), "utf8");
    expect(manifest).not.toMatch(/Bearer |authorization|apiKey|controlCapability|executeCapability|http:\/\//);
    const path = join(mount.directory, "ipc.sock");
    expect(JSON.parse((await send(path, request("catalog-1"))).trim())).toMatchObject({
      kind: "result", result: { kind: "catalog", available: true },
    });
    expect(await send(path, { ...request("wrong-operation"), operationId: "another-run" })).toBe("");
    expect(await send(path, { ...request("wrong-digest"), authorityDigest: "0".repeat(64) })).toBe("");
    expect(await send(path, request("url", { method: "provider.stream", turnId: "run-1-turn",
      request: { model: "gpt-6.1-sol", url: "https://evil.invalid" } }))).toBe("");
    expect(dispatched).toBe(1);
    expect(await send(path, request("oversized",
      { method: "mcp.tools.call", connectionId: "connection-1", tool: "search",
        arguments: { content: "x".repeat(16 * 1024 * 1024) } }))).toBe("");
    expect(dispatched).toBe(1);
    await mount.close();
    db.close();
  });

  it("persists broker receipts after the client drops its socket without resending the effect", async () => {
    let dispatched = 0;
    let started!: () => void;
    const brokerStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const { db, repository, mount } = await fixture(async function* (input) {
      dispatched++;
      started();
      await gate;
      yield { version: 2, requestId: input.requestId, sequence: 0, kind: "result",
        result: { kind: "catalog", provider: "openai-codex", model: "gpt-6.1-sol", available: true } };
    });
    const socket = connect(join(mount.directory, "ipc.sock"));
    await new Promise<void>((resolve) => socket.once("connect", () => {
      socket.write(`${JSON.stringify(request("disconnected"))}\n`);
      resolve();
    }));
    await brokerStarted;
    socket.destroy();
    finish();
    const settled = await mount.dispatcher.dispatch(request("disconnected"));
    expect(settled.at(-1)).toMatchObject({ kind: "result", result: { kind: "catalog" } });
    expect(repository.ownsRequest("run-1", "disconnected")).toBe(true);
    const replay = await send(join(mount.directory, "ipc.sock"), request("disconnected"));
    expect(JSON.parse(replay.trim())).toMatchObject({ kind: "result", result: { kind: "catalog" } });
    expect(dispatched).toBe(1);
    await mount.close();
    db.close();
  });

  it("commits a transcript and nested artifacts together, then stages a verified settled wake", async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-native-session-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.sqlite"));
    const repository = new PrimeRunRepository(db);
    const first = launch();
    repository.admit(first);
    const broker = async function* () { throw new Error("checkpoint staging cannot dispatch work"); };
    const mount = await createPrimeIpcMount({ root, request: first, repository, broker });
    const sessionId = mount.session.id;
    await writeFile(join(mount.directory, "session", `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId, cwd: first.workspace.realRoot })}\n`);
    const artifacts = join(mount.directory, "session-artifacts", sessionId, "kernel-state");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "snapshot"), "durable kernel snapshot");
    const { checkpoint, checkpointDigest } = await mount.session.commit("receipt-1");
    repository.append(first, { type: "accepted", operationId: first.operationId,
      primeSessionId: sessionId, resumed: false, sequence: 0, receiptId: "accepted-1",
      turnId: first.turnId });
    repository.append(first, { type: "terminal", sequence: 1, receiptId: "receipt-1",
      turnId: first.turnId, outcome: "completed", summary: "settled", errorCode: null, usage: null,
      session: { version: 3, ...first.identity, workspaceId: first.workspace.id,
        executionWorkspaceId: first.workspace.executionWorkspaceId,
        workspaceRoot: first.workspace.realRoot, namespace: first.authority.session.namespace,
        model: first.model.id, connectionId: first.authority.selection.connectionId,
        primeSessionId: sessionId, checkpoint, checkpointDigest, lastReceiptId: "receipt-1" },
      route: { provider: "openai-codex", model: first.model.id, billingType: "subscription" },
      finalization: null,
      settlement: { provider: "settled", worker: "stopped", descendants: "stopped",
        governedActions: "settled", evidence: ["native and broker drained"] } });
    await mount.close();
    const authority = finalAuthority({ operationId: "run-2", turnId: "run-2-turn",
      identity: { ...first.authority.identity, runId: "run-2" },
      session: { namespace: first.authority.session.namespace, previous: {
        runId: "run-1", primeSessionId: sessionId, checkpoint, checkpointDigest,
        lastReceiptId: "receipt-1",
      } } });
    const second = launch(authority);
    second.previousSession = {
      version: 3, ...first.identity, workspaceId: first.workspace.id,
      executionWorkspaceId: first.workspace.executionWorkspaceId,
      workspaceRoot: first.workspace.realRoot, namespace: first.authority.session.namespace,
      model: first.model.id, connectionId: first.authority.selection.connectionId,
      primeSessionId: sessionId, checkpoint, checkpointDigest, lastReceiptId: "receipt-1",
    };
    repository.admit(second);
    const resumed = await createPrimeIpcMount({ root, request: second, repository, broker });
    expect(resumed.session).toMatchObject({ id: sessionId, resume: true,
      directory: "/run/prime/session" });
    expect(await readFile(join(resumed.directory, "session-artifacts", sessionId,
      "kernel-state", "snapshot"), "utf8")).toBe("durable kernel snapshot");
    await resumed.close();
    db.close();
    const archive = join(root, "prime-native-checkpoints", checkpoint);
    for (const path of [archive, join(archive, "session"), join(archive, "session-artifacts"),
      join(archive, "session-artifacts", sessionId),
      join(archive, "session-artifacts", sessionId, "kernel-state")])
      await chmod(path, 0o700);
  });
});
