import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrimeRunEvent,
PrimeRunRequest,
PrimeSettlement, } from "@deepextrema/paperclip-primeagent-adapter"
import { primeCanonicalDigest } from "@deepextrema/paperclip-primeagent-adapter"
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimeControlStore } from "../src/prime-runs/prime-control-store.js";
import { PrimeRunCoordinator } from "../src/prime-runs/prime-run-coordinator.js";
import type {
  PaperclipRunIdentityVerifier,
  PrimeContainedWorker,
} from "../src/prime-runs/prime-run-port.js";
import { PrimeRunRepository } from "../src/prime-runs/prime-run-repository.js";
import {
  PrimeRestrictedIpcDispatcher,
  primeRestrictedIpcDigest,
  type PrimeRestrictedIpcRequest,
} from "../src/prime-runs/prime-restricted-ipc.js";
import { openDatabase } from "../src/store/database.js";
import { finalAuthority, launch } from "./prime-test-authority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stopped: PrimeSettlement = {
  provider: "settled",
  worker: "stopped",
  descendants: "stopped",
  governedActions: "settled",
  evidence: ["authoritative correlated receipts"],
};
const uncertain: PrimeSettlement = {
  provider: "uncertain",
  worker: "stopped",
  descendants: "stopped",
  governedActions: "uncertain",
  evidence: ["local worker stopped"],
};

function request(
  runId = "run-1",
  workspace = "/workspace",
  actor: Partial<PrimeRunRequest["identity"]> = {},
): PrimeRunRequest {
  const identity = { ...finalAuthority().identity, ...actor, runId };
  return launch(
    finalAuthority({
      operationId: runId,
      turnId: runId,
      identity,
      workspace: { ...finalAuthority().workspace, root: workspace, realRoot: workspace },
    }),
  );
}

function accepted(req: PrimeRunRequest): PrimeRunEvent {
  return {
    type: "accepted",
    sequence: 0,
    receiptId: `${req.operationId}:accepted`,
    turnId: req.turnId,
    operationId: req.operationId,
    primeSessionId: "session-1",
    resumed: req.previousSession !== null,
  };
}
function terminal(req: PrimeRunRequest, settlement: PrimeSettlement = stopped): PrimeRunEvent {
  const receiptId = `${req.operationId}:terminal`;
  return {
    type: "terminal",
    sequence: 1,
    receiptId,
    turnId: req.turnId,
    outcome: settlement.provider === "settled" ? "completed" : "uncertain",
    summary: "finished",
    errorCode: settlement.provider === "settled" ? null : "uncertain",
    usage: null,
    session: {
      version: 3,
      ...req.identity,
      workspaceId: req.workspace.id,
      executionWorkspaceId: req.workspace.executionWorkspaceId,
      workspaceRoot: req.workspace.realRoot,
      namespace: req.authority.session.namespace,
      model: req.model.id,
      connectionId: req.authority.selection.connectionId,
      primeSessionId: "session-1",
      checkpoint: settlement.provider === "settled" ? "c".repeat(64) : null,
      checkpointDigest: settlement.provider === "settled" ? "d".repeat(64) : null,
      lastReceiptId: receiptId,
    },
    route: { provider: "openai-codex", model: req.model.id, billingType: "subscription" },
    finalization: null,
    settlement,
  };
}

function verifier(calls: Array<{ token: string; method: string }>): PaperclipRunIdentityVerifier {
  const admittedDigests = new Map<string, string>();
  const admittedRequests = new Map<string, PrimeRunRequest>();
  return {
    async verify({ bearerToken, runId, request: req }) {
      if (bearerToken !== "execute-only" || runId !== req.identity.runId)
        throw new Error("execute owner mismatch");
      admittedDigests.set(runId, req.authorityDigest);
      admittedRequests.set(runId, req);
      return {
        ...req.identity,
        authorityDigest: req.authorityDigest,
        verifiedAt: new Date().toISOString(),
        workspaceId: req.workspace.id,
        executionWorkspaceId: req.workspace.executionWorkspaceId,
        workspaceRoot: req.workspace.realRoot,
        mcpConnectionIds: [],
      };
    },
    async verifyActor({ bearerToken, runId, operationId, expected }) {
      const stored = admittedRequests.get(runId);
      const owner = expected ?? stored?.identity;
      if (bearerToken !== "control-only" || !owner || runId !== owner.runId || operationId !== runId || !stored)
        throw new Error("original owner mismatch");
      return { ...owner, authorityDigest: admittedDigests.get(runId) ?? "", operationId,
        controlDeadlineAt: stored.authority.controlDeadlineAt };
    },
    async *broker(_runId, bearerToken, input) {
      if (
        !input ||
        typeof input !== "object" ||
        !("payload" in input) ||
        !input.payload ||
        typeof input.payload !== "object" ||
        !("method" in input.payload)
      )
        throw new Error("broker request invalid");
      calls.push({ token: bearerToken, method: String(input.payload.method) });
      yield {
        version: 2,
        requestId: "observed",
        sequence: 0,
        kind: "result",
        result: {
          kind: "operation",
          fenced: true,
          provider: "uncertain",
          governedActions: "uncertain",
          outstandingEffects: 1,
        },
      };
    },
  };
}

async function setup(calls: Array<{ token: string; method: string }>) {
  const root = await mkdtemp(join(tmpdir(), "prime-coordinator-"));
  roots.push(root);
  const db = openDatabase(join(root, "state.sqlite"));
  const repository = new PrimeRunRepository(db);
  const controlStore = new PrimeControlStore(join(root, "controls"), "host-stable-key");
  return { root, db, repository, controlStore, verifier: verifier(calls) };
}
const start = (req: PrimeRunRequest) => ({
  request: req,
  bearerToken: "execute-only",
  controlBearerToken: "control-only",
  headerRunId: req.identity.runId,
});
async function collect(events: AsyncIterable<PrimeRunEvent>): Promise<PrimeRunEvent[]> {
  const received: PrimeRunEvent[] = [];
  for await (const event of events) received.push(event);
  return received;
}

describe("durable Prime operation coordinator", () => {
  it("replays a settled operation without redispatch and permits a new isolated writer", async () => {
    const calls: Array<{ token: string; method: string }> = [];
    const { db, repository, controlStore, verifier: identity } = await setup(calls);
    let executions = 0;
    const worker: PrimeContainedWorker = {
      async *execute(req) {
        executions++;
        yield accepted(req);
        yield terminal(req);
      },
      cancel: vi.fn(async () => stopped),
      reconcile: vi.fn(async () => stopped),
    };
    const coordinator = new PrimeRunCoordinator(
      identity,
      worker,
      repository,
      undefined,
      controlStore,
    );
    const req = request();
    await expect(collect(await coordinator.start(start(req)))).resolves.toEqual([
      accepted(req),
      terminal(req),
    ]);
    await expect(collect(await coordinator.start(start(req)))).resolves.toEqual([
      accepted(req),
      terminal(req),
    ]);
    expect(executions).toBe(1);
    await expect(
      collect(await coordinator.start(start(request("run-2", "/workspace-2")))),
    ).resolves.toMatchObject([{ type: "accepted" }, { type: "terminal", outcome: "completed" }]);
    db.close();
  });

  it("admits a new settled wake with the original task's committed native scope", async () => {
    const { db, repository, controlStore, verifier: identity } = await setup([]);
    const worker: PrimeContainedWorker = {
      async *execute(req) { yield accepted(req); yield terminal(req); },
      cancel: vi.fn(async () => stopped),
      reconcile: vi.fn(async () => stopped),
    };
    const coordinator = new PrimeRunCoordinator(identity, worker, repository, undefined, controlStore);
    const first = request();
    await collect(await coordinator.start(start(first)));
    const previous = (terminal(first) as Extract<PrimeRunEvent, { type: "terminal" }>).session;
    const secondAuthority = finalAuthority({
      operationId: "run-2", turnId: "run-2",
      identity: { ...first.authority.identity, runId: "run-2" },
      session: { namespace: previous.namespace, previous: {
        runId: previous.runId, primeSessionId: previous.primeSessionId,
        checkpoint: previous.checkpoint!, checkpointDigest: previous.checkpointDigest!,
        lastReceiptId: previous.lastReceiptId,
      } },
    });
    const second = launch(secondAuthority);
    second.previousSession = previous;
    await expect(collect(await coordinator.start(start(second)))).resolves.toMatchObject([
      { type: "accepted", resumed: true, primeSessionId: previous.primeSessionId },
      { type: "terminal", outcome: "completed", session: { namespace: previous.namespace,
        primeSessionId: previous.primeSessionId } },
    ]);
    db.close();
  });

  it("refuses mismatched cross-wake checkpoints and retains uncertain writers", async () => {
    const calls: Array<{ token: string; method: string }> = [];
    const { db, repository, controlStore, verifier: identity } = await setup(calls);
    let executions = 0;
    const worker: PrimeContainedWorker = {
      async *execute(req) {
        executions++;
        yield accepted(req);
        yield terminal(req, uncertain);
      },
      cancel: vi.fn(async () => uncertain),
      reconcile: vi.fn(async () => uncertain),
    };
    const coordinator = new PrimeRunCoordinator(
      identity,
      worker,
      repository,
      undefined,
      controlStore,
    );
    const req = request();
    await expect(collect(await coordinator.start(start(req)))).resolves.toMatchObject([
      { type: "accepted" },
      { type: "terminal", outcome: "uncertain" },
    ]);
    await expect(coordinator.start(start(request("run-2")))).rejects.toMatchObject({
      kind: "conflict",
    });
    const resumed = request("run-3", "/workspace-3");
    const prior = (terminal(req) as Extract<PrimeRunEvent, { type: "terminal" }>).session;
    resumed.previousSession = prior;
    resumed.authority.session.previous = {
      runId: prior.runId, primeSessionId: prior.primeSessionId,
      checkpoint: prior.checkpoint!, checkpointDigest: prior.checkpointDigest!,
      lastReceiptId: prior.lastReceiptId,
    };
    resumed.authorityDigest = primeCanonicalDigest(resumed.authority);
    await expect(coordinator.start(start(resumed))).rejects.toBeInstanceOf(Error);
    expect(executions).toBe(1);
    db.close();
  });

  it("reconciles after restart with sealed original control, never a fresh execute token or PID-based release", async () => {
    const calls: Array<{ token: string; method: string }> = [];
    const { db, repository, controlStore, verifier: identity } = await setup(calls);
    const blocked: PrimeContainedWorker = {
      async *execute(req) {
        yield accepted(req);
        await new Promise<void>(() => undefined);
      },
      cancel: vi.fn(async () => "not_found" as const),
      reconcile: vi.fn(async () => "not_found" as const),
    };
    const first = new PrimeRunCoordinator(identity, blocked, repository, undefined, controlStore);
    const original = request();
    const consumer = (await first.start(start(original)))[Symbol.asyncIterator]();
    await expect(consumer.next()).resolves.toMatchObject({ value: { type: "accepted" } });
    const restarted = new PrimeRunCoordinator(
      identity,
      blocked,
      repository,
      undefined,
      controlStore,
    );
    expect(repository.replay(original.operationId).at(-1)).toMatchObject({
      type: "terminal",
      outcome: "uncertain",
      errorCode: "prime_startup_orphan",
    });
    await expect(
      restarted.reconcile({
        bearerToken: "control-only",
        headerRunId: "run-1",
        operationId: "run-1",
      }),
    ).resolves.toEqual({ operationId: "run-1", outcome: "uncertain",
      settlement: null, reconciliation: null });
    await expect(
      restarted.cancel({ bearerToken: "control-only", headerRunId: "run-1", operationId: "run-1" }),
    ).resolves.toEqual({ outcome: "uncertain", settlement: null });
    expect(calls).toEqual([
      { token: "control-only", method: "operation.status" },
      { token: "control-only", method: "operation.stop" },
    ]);
    await expect(restarted.start(start(request("run-2")))).rejects.toMatchObject({
      kind: "conflict",
    });
    db.close();
  });
  it("returns original-worker settlement only after a positively stopped cancellation", async () => {
    const { db, repository, controlStore, verifier: identity } = await setup([]);
    const worker: PrimeContainedWorker = {
      async *execute(req, signal) {
        yield accepted(req);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
      },
      cancel: vi.fn(async () => stopped),
      reconcile: vi.fn(async () => uncertain),
    };
    const coordinator = new PrimeRunCoordinator(identity, worker, repository, undefined, controlStore);
    const events = await coordinator.start(start(request()));
    const iterator = events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "accepted" } });
    await expect(coordinator.cancel({
      bearerToken: "control-only", headerRunId: "run-1", operationId: "run-1",
    })).resolves.toEqual({ outcome: "stopped", settlement: stopped });
    db.close();
  });

  it("fences and stops an active worker even if its sealed shutdown capability cannot be read", async () => {
    const { db, repository, controlStore, verifier: identity } = await setup([]);
    const cancel = vi.fn(async () => uncertain);
    const worker: PrimeContainedWorker = {
      async *execute(req, signal) {
        yield accepted(req);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
      },
      cancel,
      reconcile: vi.fn(async () => uncertain),
    };
    const coordinator = new PrimeRunCoordinator(identity, worker, repository, undefined, controlStore);
    const events = await coordinator.start(start(request()));
    const iterator = events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "accepted" } });
    vi.spyOn(controlStore, "read").mockImplementation(() => {
      throw new Error("sealed control corrupted");
    });
    await expect(coordinator.shutdown()).rejects.toThrow("control capability is unavailable");
    expect(cancel).toHaveBeenCalledWith("run-1");
    db.close();
  });

  it("recovers only the original HTTP403 PUT via an authenticated durable negative proof, then hands off", async () => {
    const calls: string[] = [];
    const { root, db, repository, controlStore, verifier: identity } = await setup([]);
    const req = request();
    const report: PrimeRestrictedIpcRequest = {
      version: 2, authorityDigest: req.authorityDigest, operationId: req.operationId,
      requestId: "original-report-put",
      payload: { method: "paperclip.request", httpMethod: "PUT",
        path: "/api/issues/issue-1", body: { report: "exact original bytes" } },
    };
    const reportDigest = primeRestrictedIpcDigest(report);
    let handoffAvailable = false;
    let mismatchedProof = true;
    identity.broker = async function* (_runId, token, raw) {
      const observation = raw as { requestId: string; payload: { method: string } };
      calls.push(`${token}:${observation.payload.method}`);
      if (observation.payload.method === "paperclip.request")
        throw new Error("Paperclip broker rejected this operation: HTTP403 before admission");
      if (observation.payload.method === "operation.reconcile_worker" && !handoffAvailable)
        throw new Error("Host handoff unavailable");
      const result = observation.payload.method === "effect.non_admission"
        ? { kind: "non_admission", state: "not_admitted", operationId: req.operationId,
          runId: req.identity.runId, authorityDigest: req.authorityDigest,
          targetRequestId: report.requestId,
          targetRequestDigest: mismatchedProof ? "b".repeat(64) : reportDigest,
          targetMethod: "paperclip.request", fence: "stopped",
          proofRequestId: observation.requestId }
        : observation.payload.method === "operation.reconcile_worker"
          ? { kind: "worker_reconciliation", state: "settled", operationId: req.operationId,
            runId: req.identity.runId, authorityDigest: req.authorityDigest,
            terminalReceiptId: `${req.operationId}:terminal`, terminalDigest: "f".repeat(64),
            worker: "stopped", descendants: "stopped", proofRequestId: observation.requestId }
          : { kind: "operation", fenced: true, provider: "settled",
            governedActions: "settled", outstandingEffects: 0 };
      yield { version: 2, requestId: observation.requestId, sequence: 0, kind: "result", result };
    };
    const native: PrimeContainedWorker = {
      async *execute(original, _signal, broker) {
        yield accepted(original);
        const dispatcher = new PrimeRestrictedIpcDispatcher(
          { ...original.authority, authorityDigest: original.authorityDigest },
          { broker: (envelope, purpose) => broker(envelope, purpose) }, repository,
        );
        expect(await dispatcher.dispatch(report)).toMatchObject([
          { kind: "error", error: { code: "broker_outcome_uncertain" } },
        ]);
        yield { ...terminal(original, uncertain), settlement: {
          ...uncertain, provider: "settled" as const,
        } };
      },
      cancel: vi.fn(async () => "not_found" as const),
      reconcile: vi.fn(async () => "not_found" as const),
    };
    const coordinator = new PrimeRunCoordinator(identity, native, repository, undefined, controlStore);
    await collect(await coordinator.start(start(req)));
    const originalTerminal = repository.replay(req.operationId).at(-1);
    const originalRows = db.prepare(`SELECT request_digest, state, response_json FROM prime_ipc_effects
      WHERE operation_id = ? AND request_id = ?`).get(req.operationId, report.requestId);
    const originalOperation = db.prepare(`SELECT terminal_json, status, checkpoint, last_sequence
      FROM prime_run_operations WHERE operation_id = ?`).get(req.operationId);
    expect(repository.unsettledEffectCount(req.operationId)).toBe(1);
    expect(await coordinator.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId }))
      .toMatchObject({ outcome: "uncertain", reconciliation: null });
    await expect(coordinator.reconcile({ bearerToken: "execute-only",
      headerRunId: req.identity.runId, operationId: req.operationId,
      recovery: { terminalReceiptId: originalTerminal!.receiptId, request: report } }))
      .rejects.toMatchObject({ kind: "unauthorized" });
    const recovery = { terminalReceiptId: originalTerminal!.receiptId, request: report };
    const expired = vi.spyOn(Date, "now").mockReturnValue(Date.parse(req.authority.controlDeadlineAt) + 1);
    try {
      await expect(coordinator.reconcile({ bearerToken: "control-only",
        headerRunId: req.identity.runId, operationId: req.operationId, recovery }))
        .rejects.toMatchObject({ kind: "unauthorized" });
    } finally { expired.mockRestore(); }
    await expect(coordinator.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId,
      recovery: { ...recovery, request: { ...report,
        payload: { ...report.payload, body: { report: "changed" } } } } }))
      .rejects.toMatchObject({ kind: "conflict" });
    expect(await coordinator.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId, recovery }))
      .toMatchObject({ outcome: "uncertain", reconciliation: null });
    expect(db.prepare("SELECT operation_id FROM prime_writer_leases WHERE operation_id = ?")
      .get(req.operationId)).toEqual({ operation_id: req.operationId });
    mismatchedProof = false;
    const pending = await coordinator.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId, recovery });
    expect(pending).toMatchObject({ outcome: "uncertain",
      settlement: { provider: "settled", worker: "stopped", descendants: "stopped",
        governedActions: "settled" },
      reconciliation: { originalTerminalReceiptId: originalTerminal!.receiptId,
        originalRequestId: report.requestId, originalRequestDigest: reportDigest,
        authorityDigest: req.authorityDigest, hostHandoff: null,
        nonAdmission: { kind: "non_admission", state: "not_admitted" } } });
    expect(db.prepare("SELECT operation_id FROM prime_writer_leases WHERE operation_id = ?")
      .get(req.operationId)).toBeUndefined();
    expect(repository.replay(req.operationId).at(-1)).toEqual(originalTerminal);
    expect(db.prepare(`SELECT request_digest, state, response_json FROM prime_ipc_effects
      WHERE operation_id = ? AND request_id = ?`).get(req.operationId, report.requestId))
      .toEqual(originalRows);
    expect(db.prepare(`SELECT terminal_json, status, checkpoint, last_sequence
      FROM prime_run_operations WHERE operation_id = ?`).get(req.operationId))
      .toEqual(originalOperation);
    db.close();
    const reopened = openDatabase(join(root, "state.sqlite"));
    const durable = new PrimeRunRepository(reopened);
    const restarted = new PrimeRunCoordinator(identity, native, durable, undefined, controlStore);
    expect(durable.reconciliation(req.operationId)).toEqual(pending.reconciliation);
    handoffAvailable = true;
    const settled = await restarted.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId });
    expect(settled).toMatchObject({ outcome: "stopped",
      reconciliation: { receiptId: pending.reconciliation!.receiptId,
        hostHandoff: { kind: "worker_reconciliation", terminalDigest: "f".repeat(64) } } });
    expect(await restarted.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId, recovery }))
      .toEqual(settled);
    await expect(restarted.reconcile({ bearerToken: "control-only",
      headerRunId: req.identity.runId, operationId: req.operationId,
      recovery: { terminalReceiptId: "forged-terminal", request: report } }))
      .rejects.toMatchObject({ kind: "conflict" });
    expect(calls.filter((call) => call.endsWith(":effect.non_admission"))).toHaveLength(2);
    expect(calls.filter((call) => call.endsWith(":paperclip.request"))).toHaveLength(1);
    reopened.close();
  });

  it("rejects a second terminal even with a fresh receipt ID and higher sequence", async () => {
    const { db, repository } = await setup([]);
    const original = request();
    repository.admit(original);
    repository.append(original, accepted(original));
    const first = terminal(original, uncertain) as Extract<PrimeRunEvent, { type: "terminal" }>;
    repository.append(original, first);
    const before = repository.replay(original.operationId);
    expect(() => repository.append(original, { ...first, sequence: 2,
      receiptId: "replacement-terminal",
      session: { ...first.session, lastReceiptId: "replacement-terminal" } }))
      .toThrow("terminal is immutable");
    expect(repository.replay(original.operationId)).toEqual(before);
    db.close();
  });

  it("requires original stopped dimensions, the sole matching uncertain row, and its own held lease", async () => {
    const { db, repository } = await setup([]);
    const req = request();
    const another = request("other", "/other", { agentId: "agent-2", issueId: "issue-2" });
    repository.admit(req);
    repository.admit(another);
    repository.append(req, accepted(req));
    const uncertainTerminal = {
      ...(terminal(req, uncertain) as Extract<PrimeRunEvent, { type: "terminal" }>),
      settlement: { ...uncertain, provider: "settled" as const },
    };
    repository.append(req, uncertainTerminal);
    const digest = "c".repeat(64);
    const target = "original-report-put";
    const error = [{ version: 2 as const, requestId: target, sequence: 0,
      kind: "error" as const, error: { code: "broker_outcome_uncertain", message: "HTTP403" } }];
    repository.reserve(req.operationId, target, digest);
    repository.markUncertain(req.operationId, target, digest, error);
    const candidate = repository.reconciliationCandidate(req.operationId);
    const proof = { kind: "non_admission" as const, state: "not_admitted" as const,
      operationId: req.operationId, runId: req.identity.runId, authorityDigest: req.authorityDigest,
      targetRequestId: target, targetRequestDigest: digest, targetMethod: "paperclip.request" as const,
      fence: "stopped" as const, proofRequestId: "durable-proof" };
    const input = { operationId: req.operationId, terminalReceiptId: uncertainTerminal.receiptId,
      terminalDigest: candidate.terminalDigest, requestId: target, requestDigest: digest, proof };
    repository.reserve(req.operationId, "other-unresolved", "d".repeat(64));
    expect(() => repository.persistReconciliation(input)).toThrow("another unresolved effect");
    expect(repository.reconciliation(req.operationId)).toBeNull();
    repository.finalize(req.operationId, "other-unresolved", "d".repeat(64), [
      { version: 2, requestId: "other-unresolved", sequence: 0, kind: "error",
        error: { code: "not_executed", message: "no execution" } },
    ]);
    expect(() => repository.persistReconciliation({ ...input,
      proof: { ...proof, targetRequestDigest: "e".repeat(64) } })).toThrow("differs");
    const receipt = repository.persistReconciliation(input);
    expect(repository.persistReconciliation(input)).toEqual(receipt);
    expect(() => repository.persistReconciliation({ ...input, proof: {
      ...proof, proofRequestId: "conflicting-proof",
    } })).toThrow("conflicts");
    expect(db.prepare("SELECT operation_id FROM prime_writer_leases WHERE operation_id = ?")
      .get(another.operationId)).toEqual({ operation_id: another.operationId });
    repository.reconcileStartupOrphans();
    expect(() => repository.reconciliationCandidate(another.operationId))
      .toThrow("Original terminal does not prove stopped worker");
    db.close();
  });

});

describe("retained Prime writer lease admission", () => {
  it.each(["active", "stopping", "uncertain"] as const)(
    "excludes parent/child roots across identities while the lease is %s",
    async (state) => {
      const { db, repository } = await setup([]);
      const parent = request("parent", "/workspace/project");
      expect(repository.admit(parent)).toBe("new");
      if (state === "stopping") repository.markStopping(parent.operationId);
      if (state === "uncertain") {
        repository.append(parent, accepted(parent));
        repository.append(parent, terminal(parent, uncertain));
      }
      expect(() =>
        repository.admit(
          request("same-company-child", "/workspace/project/other-child", {
            agentId: "other-agent",
          }),
        ),
      ).toThrow("workspace writer lease is held by parent");
      const child = request("child", "/workspace/project/subdir", {
        companyId: "other-company",
        agentId: "other-agent",
      });
      expect(() => repository.admit(child)).toThrow("workspace writer lease is held by parent");
      expect(
        repository.admit(
          request("prefix", "/workspace/project-other", {
            companyId: "other-company",
            agentId: "other-agent",
          }),
        ),
      ).toBe("new");
      db.close();
    },
  );

  it("retains an uncertain child against a different company's parent, but permits siblings", async () => {
    const { db, repository } = await setup([]);
    const child = request("child", "/workspace/project/child");
    repository.admit(child);
    repository.append(child, accepted(child));
    repository.append(child, terminal(child, uncertain));
    expect(() =>
      repository.admit(
        request("parent", "/workspace/project", {
          companyId: "other-company",
          agentId: "other-agent",
        }),
      ),
    ).toThrow("workspace writer lease is held by child");
    expect(
      repository.admit(
        request("sibling", "/workspace/project/sibling", {
          agentId: "other-agent",
          issueId: "other-issue",
        }),
      ),
    ).toBe("new");
    db.close();
  });

  it("excludes the same company's agent in disjoint roots, not other companies' agents", async () => {
    const { db, repository } = await setup([]);
    repository.admit(request("original", "/workspace/one"));
    expect(() => repository.admit(request("same-agent", "/workspace/two"))).toThrow(
      "workspace writer lease is held by original",
    );
    expect(
      repository.admit(
        request("other-company", "/workspace/two", {
          companyId: "other-company",
        }),
      ),
    ).toBe("new");
    db.close();
  });

  it("does not treat wildcard characters in workspace names as descendant matches", async () => {
    const { db, repository } = await setup([]);
    repository.admit(request("literal", "/workspace/branch_%"));
    expect(
      repository.admit(
        request("different", "/workspace/branch_ax/child", {
          companyId: "other-company",
          agentId: "other-agent",
        }),
      ),
    ).toBe("new");
    db.close();
  });

  it("keeps browser daemon writers globally exclusive, including retained uncertainty", async () => {
    const { db, repository } = await setup([]);
    repository.acquireBrowserWriter("session");
    expect(() => repository.admit(request("active"))).toThrow(
      "workspace writer lease is held by browser:session",
    );
    repository.releaseBrowserWriter("session");
    expect(() => repository.admit(request("retained", "/unrelated"))).toThrow(
      "workspace writer lease is held by browser:session",
    );
    repository.releaseStartupBrowserOrphansAfterEmptyDaemon();
    expect(repository.admit(request("after-empty", "/unrelated"))).toBe("new");
    db.close();
  });

  it("excludes positively resolved aliases of an uncertain writer's former root", async () => {
    const { root, db, repository } = await setup([]);
    const original = join(root, "workspace");
    const moved = join(root, "relocated");
    await mkdir(join(original, "child"), { recursive: true });
    const retained = request("retained", original);
    repository.admit(retained);
    repository.append(retained, accepted(retained));
    repository.append(retained, terminal(retained, uncertain));
    await rename(original, moved);
    await symlink(moved, original, "dir");
    expect(() =>
      repository.admit(
        request("alias-child", join(moved, "child"), {
          companyId: "other-company",
          agentId: "other-agent",
        }),
      ),
    ).toThrow("workspace writer lease is held by retained");
    db.close();
  });

  it("still excludes an uncertain writer's lexical subtree when its directory vanishes", async () => {
    const { root, db, repository } = await setup([]);
    const original = join(root, "workspace");
    await mkdir(original);
    const retained = request("retained", original);
    repository.admit(retained);
    repository.append(retained, accepted(retained));
    repository.append(retained, terminal(retained, uncertain));
    await rm(original, { recursive: true });
    expect(() =>
      repository.admit(
        request("missing-child", join(original, "child"), {
          companyId: "other-company",
          agentId: "other-agent",
        }),
      ),
    ).toThrow("workspace writer lease is held by retained");
    db.close();
  });
});
