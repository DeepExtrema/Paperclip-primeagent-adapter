import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { PRIME_PROVIDER,
type PrimeRunEvent,
type PrimeRunRequest,
parsePrimeRunEvent,
parsePrimeRunRequest,
sessionMatchesRequest,
settlementProvesRelease, } from "@deepextrema/paperclip-primeagent-adapter"
import type { PrimeControlStore } from "./prime-control-store.js";
import type {
  PaperclipRunIdentityVerifier,
  PrimeContainedWorker,
  PrimeRunStartInput,
  PrimeRunSurface,
  PrimeRunStopResult,
  PrimeRunReconcileResult,
} from "./prime-run-port.js";
import { PrimeRunBoundaryError } from "./prime-run-port.js";
import type { PrimeRunRepository } from "./prime-run-repository.js";
import {
  parsePrimeRestrictedIpcRequest,
  parsePrimeRestrictedIpcResponse,
  primeRestrictedIpcDigest,
  type PrimeNonAdmissionProof,
  type PrimeWorkerReconciliationProof,
} from "./prime-restricted-ipc.js";

interface ActiveRun {
  request: PrimeRunRequest;
  executeBearer: string;
  abort: AbortController;
  completed: boolean;
  version: number;
  waiters: Set<() => void>;
  runDone?: Promise<void>;
}

function uncertainTerminal(
  request: PrimeRunRequest,
  sequence: number,
  message: string,
  acceptedSession: string | null,
): PrimeRunEvent {
  const receiptId = createHash("sha256")
    .update(`${request.operationId}:${sequence}:uncertain:${message}`)
    .digest("hex");
  const prior = request.previousSession;
  return {
    type: "terminal",
    sequence,
    receiptId,
    turnId: request.turnId,
    outcome: "uncertain",
    summary: message,
    errorCode: "prime_worker_uncertain",
    usage: null,
    session: {
      version: 3,
      ...request.identity,
      workspaceId: request.workspace.id,
      executionWorkspaceId: request.workspace.executionWorkspaceId,
      workspaceRoot: request.workspace.realRoot,
      namespace: request.authority.session.namespace,
      model: request.model.id,
      connectionId: request.authority.selection.connectionId,
      primeSessionId: acceptedSession ?? prior?.primeSessionId ?? `uncertain:${request.operationId}`,
      checkpoint: null,
      checkpointDigest: null,
      lastReceiptId: receiptId,
    },
    route: { provider: PRIME_PROVIDER, model: request.model.id, billingType: "subscription" },
    finalization: null,
    settlement: {
      provider: "uncertain",
      worker: "uncertain",
      descendants: "uncertain",
      governedActions: "uncertain",
      evidence: [],
    },
  };
}

/** Durable, identity-bound execution seam between signed Paperclip wakes and one contained worker. */
export class PrimeRunCoordinator implements PrimeRunSurface {
  private readonly active = new Map<string, ActiveRun>();
  private readonly stopping = new Set<string>();
  private closing = false;

  constructor(
    private readonly verifier: PaperclipRunIdentityVerifier,
    private readonly worker: PrimeContainedWorker,
    private readonly repository: PrimeRunRepository,
    private readonly legacyWritersStopped: (() => Promise<boolean>) | undefined,
    private readonly controlStore: PrimeControlStore,
  ) {
    this.repository.reconcileStartupOrphans();
  }

  async start(input: PrimeRunStartInput): Promise<AsyncIterable<PrimeRunEvent>> {
    if (this.closing) throw new PrimeRunBoundaryError("unavailable", "Prime BFF is shutting down");
    let request: PrimeRunRequest;
    try {
      request = parsePrimeRunRequest(input.request);
    } catch (error) {
      throw new PrimeRunBoundaryError(
        "invalid",
        error instanceof Error ? error.message : "Invalid Prime run request",
      );
    }
    await this.verifier
      .verify({ bearerToken: input.bearerToken, runId: input.headerRunId, request })
      .catch((error) => {
        if (error instanceof PrimeRunBoundaryError) throw error;
        throw new PrimeRunBoundaryError(
          "unauthorized",
          "Paperclip launch authority could not be verified",
        );
      });
    const control = await this.verifier
      .verifyActor({
        bearerToken: input.controlBearerToken,
        runId: input.headerRunId,
        operationId: request.operationId,
        expected: request.identity,
      })
      .catch(() => {
        throw new PrimeRunBoundaryError(
          "unauthorized",
          "Paperclip rejected original-owner control authority",
        );
      });
    if (control.authorityDigest !== request.authorityDigest)
      throw new PrimeRunBoundaryError(
        "unauthorized",
        "execute and control capabilities bind different authorities",
      );
    if (this.stopping.has(request.operationId) || this.controlStore.isStopping(request.operationId))
      throw new PrimeRunBoundaryError("conflict", "Original-owner stop prevents new Prime admission");
    this.controlStore.save({
      purpose: "control",
      operationId: request.operationId,
      runId: request.identity.runId,
      authorityDigest: request.authorityDigest,
      controlDeadlineAt: request.authority.controlDeadlineAt,
      capability: input.controlBearerToken,
    });
    if (this.legacyWritersStopped !== undefined) {
      const stopped = await this.legacyWritersStopped().catch(() => false);
      if (!stopped)
        throw new PrimeRunBoundaryError(
          "conflict",
          "A browser/daemon writer may still own the runtime",
        );
      this.repository.releaseStartupBrowserOrphansAfterEmptyDaemon();
    }
    if (request.previousSession !== null && !sessionMatchesRequest(request.previousSession, request))
      throw new PrimeRunBoundaryError("conflict", "previous Prime checkpoint belongs to another scope");
    // Verification and legacy-writer checks await I/O; accepted stops win before admission.
    await this.verifier.verify({ bearerToken: input.bearerToken, runId: input.headerRunId, request });
    if (this.closing) throw new PrimeRunBoundaryError("unavailable", "Prime BFF is shutting down");
    if (this.stopping.has(request.operationId) || this.controlStore.isStopping(request.operationId))
      throw new PrimeRunBoundaryError("conflict", "Original-owner stop prevents new Prime admission");
    let admission: "new" | "replay";
    try {
      admission = this.repository.admit(request);
    } catch (error) {
      throw new PrimeRunBoundaryError(
        "conflict",
        error instanceof Error ? error.message : "Prime writer lease is unavailable",
      );
    }
    if (admission === "replay") {
      const active = this.active.get(request.operationId);
      return active ? this.follow(active) : this.replay(request.operationId);
    }
    const active: ActiveRun = {
      request,
      executeBearer: input.bearerToken,
      abort: new AbortController(),
      completed: false,
      version: 0,
      waiters: new Set(),
    };
    this.active.set(request.operationId, active);
    active.runDone = this.run(active);
    return this.follow(active);
  }

  private async *replay(operationId: string): AsyncIterable<PrimeRunEvent> {
    yield* this.repository.replay(operationId);
  }

  private notify(active: ActiveRun): void {
    active.version += 1;
    for (const wake of active.waiters) wake();
    active.waiters.clear();
  }

  private async *follow(active: ActiveRun): AsyncIterable<PrimeRunEvent> {
    let afterSequence = -1;
    while (true) {
      const version = active.version;
      const events = this.repository.replay(active.request.operationId, afterSequence);
      for (const event of events) {
        afterSequence = event.sequence;
        yield event;
        if (event.type === "terminal") return;
      }
      if (events.length > 0) continue;
      if (active.completed) return;
      if (active.version !== version) continue;
      await new Promise<void>((resolve) => active.waiters.add(resolve));
    }
  }

  private async run(active: ActiveRun): Promise<void> {
    let terminal = false;
    let accepted = false;
    let acceptedSession: string | null = null;
    let lastSequence = -1;
    try {
      for await (const raw of this.worker.execute(
        active.request,
        active.abort.signal,
        (request, purpose) => {
          const bearer =
            purpose === "control"
              ? this.controlStore.read(active.request.operationId)?.capability
              : active.executeBearer;
          if (!bearer) throw new Error("original-owner purpose capability missing");
          return this.verifier.broker(active.request.identity.runId, bearer, request);
        },
      )) {
        const event = parsePrimeRunEvent(raw);
        if (terminal || event.turnId !== active.request.turnId)
          throw new Error("worker receipt escaped the admitted turn");
        if (event.sequence <= lastSequence)
          throw new Error("worker receipt sequence is not increasing");
        if (event.type === "accepted") {
          if (accepted || event.operationId !== active.request.operationId)
            throw new Error("worker acceptance receipt is invalid");
          accepted = true;
          acceptedSession = event.primeSessionId;
        } else if (!accepted) throw new Error("worker emitted activity before acceptance");
        if (event.type === "terminal") {
          if (
            !sessionMatchesRequest(event.session, active.request) ||
            event.session.primeSessionId !== acceptedSession ||
            event.route.model !== active.request.model.id ||
            event.outcome === "completed" && (
              event.session.checkpoint === null || event.session.checkpointDigest === null))
            throw new Error("worker terminal session escaped the admitted identity");
          terminal = true;
        }
        this.repository.append(active.request, event);
        this.notify(active);
        lastSequence = event.sequence;
      }
      if (!terminal) {
        const event = uncertainTerminal(
          active.request,
          lastSequence + 1,
          "Prime worker ended without a terminal receipt",
          acceptedSession,
        );
        this.repository.append(active.request, event);
        this.notify(active);
      }
    } catch {
      if (!terminal) {
        const event = uncertainTerminal(
          active.request,
          lastSequence + 1,
          "Prime worker outcome is uncertain",
          acceptedSession,
        );
        try {
          this.repository.append(active.request, event);
          this.notify(active);
        } catch {
          /* existing durable receipt wins */
        }
      }
    } finally {
      active.completed = true;
      this.notify(active);
      if (this.active.get(active.request.operationId) === active)
        this.active.delete(active.request.operationId);
    }
  }

  private async authorizeControl(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
  }): Promise<boolean> {
    const original = this.controlStore.read(input.operationId);
    if (original) {
      const provided = Buffer.from(input.bearerToken);
      const authenticated = Buffer.from(original.capability);
      if (original.runId !== input.headerRunId || Date.parse(original.controlDeadlineAt) <= Date.now() ||
        provided.length !== authenticated.length || !timingSafeEqual(provided, authenticated))
        throw new PrimeRunBoundaryError("unauthorized", "Original-owner control capability rejected");
      // This sealed capability was purpose-verified by Paperclip before persistence.
      // Neither local stop nor original receipt access needs another network authentication.
      return true;
    }
    const expected = this.repository.identity(input.operationId);
    const verified = await this.verifier.verifyActor({
      bearerToken: input.bearerToken,
      runId: input.headerRunId,
      operationId: input.operationId,
      ...(expected ? { expected } : {}),
    });
    this.controlStore.save({
      purpose: "control",
      operationId: verified.operationId,
      runId: verified.runId,
      authorityDigest: verified.authorityDigest,
      controlDeadlineAt: verified.controlDeadlineAt,
      capability: input.bearerToken,
    });
    return true;
  }

  async observe(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
    afterSequence: number;
  }): Promise<PrimeRunEvent[]> {
    if (!(await this.authorizeControl(input)))
      throw new PrimeRunBoundaryError(
        "unauthorized",
        "No owned Prime operation matches this identity",
      );
    return this.repository.replay(input.operationId, input.afterSequence);
  }

  /** After a BFF restart the sealed control capability can observe or fence the
   * original Paperclip operation; lost local PID ownership still cannot release a writer. */
  private async recoverRemoteControl(operationId: string, stop: boolean): Promise<void> {
    const control = this.controlStore.read(operationId);
    const owner = this.repository.identity(operationId);
    if (
      !control ||
      owner && control.runId !== owner.runId ||
      Date.parse(control.controlDeadlineAt) <= Date.now()
    )
      return;
    const request = {
      version: 2 as const,
      authorityDigest: control.authorityDigest,
      operationId,
      requestId: `${stop ? "stop" : "status"}:${randomUUID()}`,
      payload: { method: stop ? "operation.stop" : "operation.status" },
    };
    for await (const frame of this.verifier.broker(control.runId, control.capability, request)) {
      if (frame && typeof frame === "object" && "kind" in frame && frame.kind === "error") return;
    }
  }

  async cancel(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
  }): Promise<PrimeRunStopResult> {
    if (!(await this.authorizeControl(input))) return { outcome: "not_found", settlement: null };
    this.stopping.add(input.operationId);
    const active = this.active.get(input.operationId);
    active?.abort.abort();
    try {
      this.controlStore.markStopping(input.operationId);
      if (active) this.repository.markStopping(input.operationId);
    } catch (error) {
      // Durable-write failure cannot skip local cancellation or original-owner fencing.
      await this.worker.cancel(input.operationId);
      await this.recoverRemoteControl(input.operationId, true).catch(() => undefined);
      throw error;
    }
    if (!active) {
      await this.recoverRemoteControl(input.operationId, true).catch(() => undefined);
      return { outcome: "uncertain", settlement: null };
    }
    const settlement = await this.worker.cancel(input.operationId);
    if (settlement === "not_found") {
      await this.recoverRemoteControl(input.operationId, true).catch(() => undefined);
      return { outcome: "uncertain", settlement: null };
    }
    this.repository.settleCancel(input.operationId, settlement);
    if (settlementProvesRelease(settlement)) {
      this.active.delete(input.operationId);
      return { outcome: "stopped", settlement };
    }
    return { outcome: "uncertain", settlement: null };
  }

  /** Stop accepting work, fence every owned operation, and drain receipt writers before DB close. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    const results = await Promise.allSettled(active.map(async (run) => {
      let capability: string | null;
      try { capability = this.controlStore.read(run.request.operationId)?.capability ?? null; }
      catch { capability = null; }
      if (!capability) {
        this.stopping.add(run.request.operationId);
        run.abort.abort();
        try { this.repository.markStopping(run.request.operationId); }
        catch { /* The retained uncertain lease must not be released by a failed stop marker. */ }
        try { await this.worker.cancel(run.request.operationId); }
        catch { /* Local fence/termination was attempted; the writer remains quarantined. */ }
        throw new Error("Original-owner control capability is unavailable during shutdown");
      }
      const result = await this.cancel({
        bearerToken: capability,
        headerRunId: run.request.identity.runId,
        operationId: run.request.operationId,
      });
      if (result.outcome !== "stopped")
        throw new Error("Prime shutdown cannot close while an original-owner writer remains uncertain");
      return result;
    }));
    await Promise.allSettled(active.map((run) => run.runDone));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  /** Host observations run only over the sealed original control capability. Never forward the PUT. */
  private async observeHostProof(
    operationId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const control = this.controlStore.read(operationId);
    const owner = this.repository.identity(operationId);
    if (!control || !owner || control.runId !== owner.runId ||
      Date.parse(control.controlDeadlineAt) <= Date.now())
      throw new Error("Original-owner control is unavailable for host proof");
    const request = {
      version: 2 as const,
      operationId,
      authorityDigest: control.authorityDigest,
      requestId,
      payload,
    };
    let result: Record<string, unknown> | null = null;
    for await (const raw of this.verifier.broker(control.runId, control.capability, request)) {
      if (result !== null) throw new Error("Host emitted a second proof frame");
      const frame = parsePrimeRestrictedIpcResponse(raw, requestId);
      if (frame.kind !== "result" || frame.sequence !== 0)
        throw new Error("Host did not return one durable proof result");
      result = frame.result;
    }
    if (result === null) throw new Error("Host proof was not persisted");
    return result;
  }

  private async handoffReconciliation(operationId: string): Promise<PrimeRunReconcileResult> {
    let receipt = this.repository.reconciliation(operationId);
    if (!receipt) throw new Error("Original reconciliation receipt is unavailable");
    if (!receipt.hostHandoff) {
      const requestId = `reconcile-worker:${receipt.receiptId}`;
      try {
        const result = await this.observeHostProof(operationId, requestId, {
          method: "operation.reconcile_worker",
          terminalReceiptId: receipt.originalTerminalReceiptId,
        });
        if (result.kind !== "worker_reconciliation" || result.state !== "settled" ||
          result.operationId !== operationId || result.runId !== this.repository.identity(operationId)?.runId ||
          result.authorityDigest !== receipt.authorityDigest ||
          result.terminalReceiptId !== receipt.originalTerminalReceiptId ||
          result.proofRequestId !== requestId || result.worker !== "stopped" ||
          result.descendants !== "stopped")
          throw new Error("Host worker reconciliation proof does not match the original operation");
        receipt = this.repository.appendReconciliationHandoff(
          operationId, result as unknown as PrimeWorkerReconciliationProof,
        );
      } catch {
        // Local release is durable; the host's independent physical writer remains excluded.
        return { operationId, outcome: "uncertain", settlement: receipt.settlement,
          reconciliation: receipt };
      }
    }
    return { operationId, outcome: "stopped", settlement: receipt.settlement,
      reconciliation: receipt };
  }

  async reconcile(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
    recovery?: { terminalReceiptId: string; request: unknown };
  }): Promise<PrimeRunReconcileResult> {
    const { operationId } = input;
    const persisted = this.repository.reconciliation(operationId);
    if ((input.recovery || persisted) && !this.controlStore.read(operationId))
      throw new PrimeRunBoundaryError("unauthorized", "Original sealed control is required");
    if (!(await this.authorizeControl(input)))
      return { operationId, outcome: "not_found", settlement: null, reconciliation: null };
    if (input.recovery) {
      let original;
      try { original = parsePrimeRestrictedIpcRequest(input.recovery.request); }
      catch { throw new PrimeRunBoundaryError("invalid", "Original broker envelope is invalid"); }
      const digest = primeRestrictedIpcDigest(original);
      if (original.payload.method !== "paperclip.request" ||
        original.payload.httpMethod !== "PUT" || original.operationId !== operationId)
        throw new PrimeRunBoundaryError("conflict", "Only the original Paperclip PUT may be reconciled");
      if (persisted && (persisted.originalTerminalReceiptId !== input.recovery.terminalReceiptId ||
        persisted.originalRequestId !== original.requestId ||
        persisted.originalRequestDigest !== digest ||
        persisted.authorityDigest !== original.authorityDigest))
        throw new PrimeRunBoundaryError("conflict", "Reconciliation conflicts with the original receipt");
      if (!persisted) {
        if (this.active.has(operationId) || (await this.worker.reconcile(operationId)) !== "not_found")
          throw new PrimeRunBoundaryError("conflict", "Original worker or dispatcher still owns the operation");
        let candidate;
        try { candidate = this.repository.reconciliationCandidate(operationId); }
        catch { throw new PrimeRunBoundaryError("conflict", "Original stopped terminal evidence is unavailable"); }
        const control = this.controlStore.read(operationId);
        if (candidate.request.identity.runId !== input.headerRunId ||
          candidate.request.authorityDigest !== original.authorityDigest ||
          control?.authorityDigest !== original.authorityDigest ||
          candidate.terminal.receiptId !== input.recovery.terminalReceiptId)
          throw new PrimeRunBoundaryError("conflict", "Original run, authority or terminal differs");
        const effect = this.repository.recoveryEffect(operationId, original.requestId);
        if (effect?.state !== "uncertain" || effect.digest !== digest)
          throw new PrimeRunBoundaryError("conflict", "Original uncertain request digest is unavailable");
        const proofRequestId = `non-admission:${createHash("sha256")
          .update(`${operationId}:${original.requestId}:${digest}`).digest("hex")}`;
        let proof: PrimeNonAdmissionProof;
        try {
          const result = await this.observeHostProof(operationId, proofRequestId, {
            method: "effect.non_admission",
            targetRequestId: original.requestId,
            targetRequestDigest: digest,
            targetMethod: "paperclip.request",
          });
          if (result.kind !== "non_admission" || result.state !== "not_admitted" ||
            result.operationId !== operationId || result.runId !== input.headerRunId ||
            result.authorityDigest !== original.authorityDigest ||
            result.targetRequestId !== original.requestId ||
            result.targetRequestDigest !== digest || result.targetMethod !== "paperclip.request" ||
            result.fence !== "stopped" || result.proofRequestId !== proofRequestId)
            throw new Error("Host non-admission proof does not bind the original request");
          proof = result as unknown as PrimeNonAdmissionProof;
        } catch {
          return { operationId, outcome: "uncertain", settlement: null, reconciliation: null };
        }
        try {
          this.repository.persistReconciliation({
            operationId, terminalReceiptId: candidate.terminal.receiptId,
            terminalDigest: candidate.terminalDigest, requestId: original.requestId,
            requestDigest: digest, proof,
          });
        } catch {
          throw new PrimeRunBoundaryError("conflict", "Original recovery evidence or lease has changed");
        }
      }
    }
    if (this.repository.reconciliation(operationId))
      return this.handoffReconciliation(operationId);
    const settlement = await this.worker.reconcile(operationId);
    if (settlement === "not_found") {
      try { await this.recoverRemoteControl(operationId, false); }
      catch { /* Keep the startup-orphan writer fenced. */ }
      return { operationId, outcome: "uncertain", settlement: null, reconciliation: null };
    }
    this.repository.settleCancel(operationId, settlement);
    return settlementProvesRelease(settlement)
      ? { operationId, outcome: "stopped", settlement, reconciliation: null }
      : { operationId, outcome: "uncertain", settlement: null, reconciliation: null };
  }
}
