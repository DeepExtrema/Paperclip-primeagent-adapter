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
    ).resolves.toBe("uncertain");
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
