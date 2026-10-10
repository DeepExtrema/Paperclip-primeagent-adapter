import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { PrimeRunEvent,
PrimeRunIdentity,
PrimeRunRequest,
PrimeSettlement, } from "@deepextrema/paperclip-primeagent-adapter"
import { PRIME_PROVIDER,
sessionMatchesRequest,
settlementProvesRelease, } from "@deepextrema/paperclip-primeagent-adapter"
import type { DatabaseType } from "../store/database.js";
import type { PrimeReconciliationReceipt } from "./prime-run-port.js";
import type { PrimeNonAdmissionProof, PrimeWorkerReconciliationProof } from "./prime-restricted-ipc.js";
import type {
  PrimeRestrictedIpcReservation,
  PrimeRestrictedIpcResponse,
  PrimeRestrictedIpcStore,
} from "./prime-restricted-ipc.js";

export interface StoredPrimeOperation {
  request: PrimeRunRequest;
  status: string;
  terminal: PrimeRunEvent | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function requestDigest(request: PrimeRunRequest): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function rootsOverlap(left: string, right: string): boolean {
  const leftChildren = left === "/" ? "/" : `${left}/`;
  const rightChildren = right === "/" ? "/" : `${right}/`;
  return left === right || right.startsWith(leftChildren) || left.startsWith(rightChildren);
}

function knownRealRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch (error) {
    // A vanished retained writer still owns its lexical root; only a
    // positively resolved filesystem alias can add another exclusion.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return null;
    throw error;
  }
}

export class PrimeRunRepository implements PrimeRestrictedIpcStore {
  constructor(
    private readonly db: DatabaseType,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A BFF restart cannot prove an inherited worker stopped. Keep every orphan lease. */
  reconcileStartupOrphans(): number {
    const at = this.now().toISOString();
    return this.db
      .transaction(() => {
        const orphans = this.db
          .prepare(`SELECT operation_id, company_id, agent_id, issue_id, run_id, turn_id,
            workspace_id, execution_workspace_id, workspace_root, prime_session_id,
            checkpoint, last_sequence, request_json
            FROM prime_run_operations
            WHERE status IN ('admitted', 'running', 'awaiting_approval')`)
          .all() as Array<{
          operation_id: string;
          company_id: string;
          agent_id: string;
          issue_id: string;
          run_id: string;
          turn_id: string;
          workspace_id: string;
          execution_workspace_id: string;
          workspace_root: string;
          prime_session_id: string | null;
          checkpoint: string | null;
          last_sequence: number;
          request_json: string | null;
        }>;
        const changed = this.db
          .prepare(
            "UPDATE prime_writer_leases SET state = 'uncertain', updated_at = ? WHERE state IN ('active', 'stopping')",
          )
          .run(at).changes;
        for (const orphan of orphans) {
          if (orphan.request_json === null) {
            this.db.prepare("UPDATE prime_run_operations SET status = 'uncertain', updated_at = ? WHERE operation_id = ?")
              .run(at, orphan.operation_id);
            continue;
          }
          const request = JSON.parse(orphan.request_json) as PrimeRunRequest;
          const sequence = orphan.last_sequence + 1;
          const receiptId = createHash("sha256")
            .update(`${orphan.operation_id}:${sequence}:startup-orphan`)
            .digest("hex");
          const terminal: PrimeRunEvent = {
            type: "terminal",
            sequence,
            receiptId,
            turnId: orphan.turn_id,
            outcome: "uncertain",
            summary: "Prime worker ownership was lost during BFF startup reconciliation",
            errorCode: "prime_startup_orphan",
            usage: null,
            session: {
              version: 3,
              companyId: orphan.company_id,
              agentId: orphan.agent_id,
              issueId: orphan.issue_id,
              runId: orphan.run_id,
              workspaceId: orphan.workspace_id,
              executionWorkspaceId: orphan.execution_workspace_id,
              workspaceRoot: orphan.workspace_root,
              namespace: request.authority.session.namespace,
              model: request.model.id,
              connectionId: request.authority.selection.connectionId,
              primeSessionId: orphan.prime_session_id ?? `uncertain:${orphan.operation_id}`,
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
          this.db
            .prepare(`INSERT INTO prime_run_receipts
              (operation_id, sequence, receipt_id, turn_id, event_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              orphan.operation_id,
              sequence,
              receiptId,
              orphan.turn_id,
              JSON.stringify(terminal),
              at,
            );
          this.db
            .prepare(`UPDATE prime_run_operations
              SET status = 'uncertain', terminal_json = ?, last_sequence = ?, updated_at = ?
              WHERE operation_id = ?`)
            .run(JSON.stringify(terminal), sequence, at, orphan.operation_id);
        }
        return changed;
      })
      .immediate();
  }

  admit(request: PrimeRunRequest): "new" | "replay" {
    const at = this.now().toISOString();
    const digest = requestDigest(request);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT request_digest FROM prime_run_operations WHERE operation_id = ?")
          .get(request.operationId) as { request_digest: string } | undefined;
        if (existing) {
          if (existing.request_digest !== digest)
            throw new Error("operation ID was reused with a different request");
          return "replay" as const;
        }
        if (request.previousSession !== null) {
          const previous = request.previousSession;
          const row = this.db.prepare(
            "SELECT status, terminal_json FROM prime_run_operations WHERE operation_id = ? AND run_id = ?",
          ).get(previous.runId, previous.runId) as
            { status: string; terminal_json: string | null } | undefined;
          if (row?.status !== "completed" || !row.terminal_json)
            throw new Error("previous native operation is not positively settled");
          const terminal = JSON.parse(row.terminal_json) as PrimeRunEvent;
          if (terminal.type !== "terminal" || terminal.outcome !== "completed" ||
            !settlementProvesRelease(terminal.settlement) ||
            terminal.receiptId !== previous.lastReceiptId ||
            terminal.session.namespace !== request.authority.session.namespace ||
            terminal.session.primeSessionId !== previous.primeSessionId ||
            terminal.session.checkpoint !== previous.checkpoint ||
            terminal.session.checkpointDigest !== previous.checkpointDigest ||
            terminal.session.workspaceRoot !== request.workspace.realRoot ||
            terminal.session.companyId !== request.identity.companyId ||
            terminal.session.agentId !== request.identity.agentId ||
            terminal.session.issueId !== request.identity.issueId ||
            terminal.session.model !== request.model.id ||
            terminal.session.connectionId !== request.authority.selection.connectionId)
            throw new Error("previous native checkpoint does not match the committed session");
        }
        const leases = this.db
          .prepare(
            "SELECT operation_id, workspace_root, writer_kind, company_id, agent_id, issue_id FROM prime_writer_leases",
          )
          .all() as Array<{
          operation_id: string;
          workspace_root: string;
          writer_kind: string;
          company_id: string | null;
          agent_id: string | null;
          issue_id: string | null;
        }>;
        let candidateRealRoot: string | null | undefined;
        for (const lease of leases) {
          let conflict =
            lease.writer_kind === "browser_daemon" ||
            (lease.company_id === request.identity.companyId &&
              (lease.agent_id === request.identity.agentId || lease.issue_id === request.identity.issueId)) ||
            rootsOverlap(lease.workspace_root, request.workspace.realRoot);
          if (!conflict) {
            if (candidateRealRoot === undefined)
              candidateRealRoot = knownRealRoot(request.workspace.realRoot);
            if (candidateRealRoot !== null) {
              const retainedRealRoot = knownRealRoot(lease.workspace_root);
              conflict =
                retainedRealRoot !== null && rootsOverlap(retainedRealRoot, candidateRealRoot);
            }
          }
          if (conflict) throw new Error(`workspace writer lease is held by ${lease.operation_id}`);
        }
        this.db
          .prepare(`INSERT INTO prime_run_operations
        (operation_id, company_id, agent_id, issue_id, run_id, turn_id, workspace_id,
         execution_workspace_id, workspace_root, prime_session_id, checkpoint,
         request_digest, request_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', ?, ?)`)
          .run(
            request.operationId,
            request.identity.companyId,
            request.identity.agentId,
            request.identity.issueId,
            request.identity.runId,
            request.turnId,
            request.workspace.id,
            request.workspace.executionWorkspaceId,
            request.workspace.realRoot,
            request.previousSession?.primeSessionId ?? null,
            request.previousSession?.checkpoint ?? null,
            digest,
            JSON.stringify(request),
            at,
            at,
          );
        this.db
          .prepare(`INSERT INTO prime_writer_leases
        (workspace_root, operation_id, writer_kind, company_id, agent_id, issue_id, run_id, state, acquired_at, updated_at)
        VALUES (?, ?, 'paperclip_prime', ?, ?, ?, ?, 'active', ?, ?)`)
          .run(
            request.workspace.realRoot,
            request.operationId,
            request.identity.companyId,
            request.identity.agentId,
            request.identity.issueId,
            request.identity.runId,
            at,
            at,
          );
        return "new" as const;
      })
      .immediate();
  }

  /** Browser daemon mutations retain a global durable lease until their attached session is disposed. */
  acquireBrowserWriter(activeSessionId: string): void {
    const operationId = `browser:${activeSessionId}`;
    const workspaceRoot = operationId;
    const at = this.now().toISOString();
    this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT writer_kind FROM prime_writer_leases WHERE operation_id = ?")
          .get(operationId) as { writer_kind: string } | undefined;
        if (existing?.writer_kind === "browser_daemon") return;
        const prime = this.db
          .prepare(
            "SELECT operation_id FROM prime_writer_leases WHERE writer_kind = 'paperclip_prime'",
          )
          .get();
        if (prime) throw new Error("Paperclip Prime holds the exclusive writer lease");
        this.db
          .prepare(`INSERT INTO prime_writer_leases
        (workspace_root, operation_id, writer_kind, company_id, agent_id, issue_id, run_id, state, acquired_at, updated_at)
        VALUES (?, ?, 'browser_daemon', NULL, NULL, NULL, NULL, 'active', ?, ?)`)
          .run(workspaceRoot, operationId, at, at);
      })
      .immediate();
  }

  releaseBrowserWriter(activeSessionId: string): void {
    // Releasing the BFF attachment is not proof that the daemon worker stopped.
    // The next Prime admission may clear this only after an empty live catalog.
    this.db
      .prepare(
        "UPDATE prime_writer_leases SET state = 'uncertain', updated_at = ? WHERE operation_id = ? AND writer_kind = 'browser_daemon'",
      )
      .run(this.now().toISOString(), `browser:${activeSessionId}`);
  }

  releaseStartupBrowserOrphansAfterEmptyDaemon(): number {
    return this.db
      .prepare(
        "DELETE FROM prime_writer_leases WHERE writer_kind = 'browser_daemon' AND state = 'uncertain'",
      )
      .run().changes;
  }

  append(request: PrimeRunRequest, event: PrimeRunEvent): void {
    const at = this.now().toISOString();
    this.db
      .transaction(() => {
        const duplicate = this.db
          .prepare("SELECT event_json FROM prime_run_receipts WHERE receipt_id = ?")
          .get(event.receiptId) as { event_json: string } | undefined;
        if (duplicate) {
          if (duplicate.event_json !== JSON.stringify(event))
            throw new Error("receipt ID was reused");
          return;
        }
        const row = this.db
          .prepare("SELECT last_sequence, terminal_json FROM prime_run_operations WHERE operation_id = ?")
          .get(request.operationId) as { last_sequence: number; terminal_json: string | null } | undefined;
        if (!row || event.sequence <= row.last_sequence)
          throw new Error("receipt sequence is not increasing");
        if (row.terminal_json !== null)
          throw new Error("Prime terminal is immutable; subsequent receipts require reconciliation storage");
        this.db
          .prepare(`INSERT INTO prime_run_receipts
        (operation_id, sequence, receipt_id, turn_id, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            request.operationId,
            event.sequence,
            event.receiptId,
            event.turnId,
            JSON.stringify(event),
            at,
          );
        const status =
          event.type === "terminal"
            ? event.outcome
            : event.type === "approval_wait"
              ? "awaiting_approval"
              : "running";
        this.db
          .prepare(
            `UPDATE prime_run_operations SET status = ?, terminal_json = ?, last_sequence = ?,
              prime_session_id = COALESCE(?, prime_session_id),
              checkpoint = COALESCE(?, checkpoint), updated_at = ? WHERE operation_id = ?`,
          )
          .run(
            status,
            event.type === "terminal" ? JSON.stringify(event) : null,
            event.sequence,
            event.type === "accepted" ? event.primeSessionId : null,
            event.type === "terminal" ? event.session.checkpoint :
              event.type === "checkpoint" ? event.checkpoint : null,
            at,
            request.operationId,
          );
        if (event.type === "terminal" && event.outcome !== "uncertain" &&
          settlementProvesRelease(event.settlement)) {
          this.db
            .prepare("DELETE FROM prime_writer_leases WHERE operation_id = ?")
            .run(request.operationId);
        } else if (event.type === "terminal") {
          this.db
            .prepare(
              "UPDATE prime_writer_leases SET state = 'uncertain', updated_at = ? WHERE operation_id = ?",
            )
            .run(at, request.operationId);
        }
      })
      .immediate();
  }

  replay(operationId: string, afterSequence = -1): PrimeRunEvent[] {
    const rows = this.db
      .prepare(
        "SELECT event_json FROM prime_run_receipts WHERE operation_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(operationId, afterSequence) as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as PrimeRunEvent);
  }

  owns(
    operationId: string,
    identity: { companyId: string; agentId: string; issueId: string },
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM prime_run_operations WHERE operation_id = ? AND company_id = ? AND agent_id = ? AND issue_id = ?",
      )
      .get(operationId, identity.companyId, identity.agentId, identity.issueId);
    return row !== undefined;
  }

  identity(operationId: string): PrimeRunIdentity | null {
    const row = this.db
      .prepare(
        "SELECT company_id, agent_id, issue_id, run_id FROM prime_run_operations WHERE operation_id = ?",
      )
      .get(operationId) as
      | {
          company_id: string;
          agent_id: string;
          issue_id: string;
          run_id: string;
        }
      | undefined;
    return row
      ? {
          companyId: row.company_id,
          agentId: row.agent_id,
          issueId: row.issue_id,
          runId: row.run_id,
        }
      : null;
  }

  markStopping(operationId: string): void {
    this.db
      .prepare(
        "UPDATE prime_writer_leases SET state = 'stopping', updated_at = ? WHERE operation_id = ?",
      )
      .run(this.now().toISOString(), operationId);
  }

  settleCancel(operationId: string, settlement: PrimeSettlement): void {
    const at = this.now().toISOString();
    if (settlementProvesRelease(settlement)) {
      this.db.prepare("DELETE FROM prime_writer_leases WHERE operation_id = ?").run(operationId);
    } else {
      this.db
        .prepare(
          "UPDATE prime_writer_leases SET state = 'uncertain', updated_at = ? WHERE operation_id = ?",
        )
        .run(at, operationId);
    }
  }

  /** The original terminal, not a claimed settlement or an orphaned PID, supplies worker provenance. */
  reconciliationCandidate(operationId: string): {
    request: PrimeRunRequest;
    terminal: Extract<PrimeRunEvent, { type: "terminal" }>;
    terminalDigest: string;
  } {
    const row = this.db.prepare(`SELECT request_json, request_digest, terminal_json, status,
      last_sequence, checkpoint, prime_session_id
      FROM prime_run_operations WHERE operation_id = ?`).get(operationId) as {
      request_json: string | null; request_digest: string; terminal_json: string | null;
      status: string; last_sequence: number; checkpoint: string | null; prime_session_id: string | null;
    } | undefined;
    if (!row?.request_json || !row.terminal_json || row.status !== "uncertain")
      throw new Error("Original uncertain Prime terminal is unavailable");
    const request = JSON.parse(row.request_json) as PrimeRunRequest;
    const terminal = JSON.parse(row.terminal_json) as PrimeRunEvent;
    const original = this.db.prepare(`SELECT event_json FROM prime_run_receipts
      WHERE operation_id = ? AND receipt_id = ? AND sequence = ?`)
      .get(operationId, terminal.receiptId, terminal.sequence) as { event_json: string } | undefined;
    const accepted = this.db.prepare(`SELECT event_json FROM prime_run_receipts
      WHERE operation_id = ? AND sequence < ? AND json_extract(event_json, '$.type') = 'accepted'`)
      .all(operationId, terminal.sequence) as Array<{ event_json: string }>;
    const terminalCount = this.db.prepare(`SELECT count(*) AS count FROM prime_run_receipts
      WHERE operation_id = ? AND json_extract(event_json, '$.type') = 'terminal'`)
      .get(operationId) as { count: number };
    if (requestDigest(request) !== row.request_digest || request.operationId !== operationId ||
      terminal.type !== "terminal" || original?.event_json !== row.terminal_json ||
      terminal.sequence !== row.last_sequence || terminal.turnId !== request.turnId ||
      terminal.outcome !== "uncertain" || terminal.finalization !== null ||
      terminal.settlement.provider !== "settled" || terminal.settlement.worker !== "stopped" ||
      terminal.settlement.descendants !== "stopped" ||
      terminal.settlement.governedActions !== "uncertain" ||
      !Array.isArray(terminal.settlement.evidence) || terminal.settlement.evidence.length === 0 ||
      terminal.session.runId !== request.identity.runId ||
      terminal.session.lastReceiptId !== terminal.receiptId ||
      terminal.session.checkpoint !== null || terminal.session.checkpointDigest !== null ||
      row.checkpoint !== null || row.prime_session_id !== terminal.session.primeSessionId ||
      !sessionMatchesRequest(terminal.session, request) || accepted.length !== 1 ||
      terminalCount.count !== 1)
      throw new Error("Original terminal does not prove stopped worker and settled provider");
    const acceptance = JSON.parse(accepted[0]!.event_json) as PrimeRunEvent;
    if (acceptance.type !== "accepted" || acceptance.operationId !== operationId ||
      acceptance.turnId !== request.turnId ||
      acceptance.primeSessionId !== terminal.session.primeSessionId)
      throw new Error("Original worker acceptance and terminal do not correlate");
    return { request, terminal, terminalDigest: createHash("sha256").update(row.terminal_json).digest("hex") };
  }

  reconciliation(operationId: string): PrimeReconciliationReceipt | null {
    const row = this.db.prepare(`SELECT receipt_json FROM prime_run_reconciliations
      WHERE operation_id = ?`).get(operationId) as { receipt_json: string } | undefined;
    if (!row) return null;
    const handoff = this.db.prepare(`SELECT proof_json FROM prime_run_reconciliation_handoffs
      WHERE operation_id = ?`).get(operationId) as { proof_json: string } | undefined;
    return { ...(JSON.parse(row.receipt_json) as Omit<PrimeReconciliationReceipt, "hostHandoff">),
      hostHandoff: handoff ? JSON.parse(handoff.proof_json) as PrimeWorkerReconciliationProof : null };
  }

  persistReconciliation(input: {
    operationId: string;
    terminalReceiptId: string;
    terminalDigest: string;
    requestId: string;
    requestDigest: string;
    proof: PrimeNonAdmissionProof;
  }): PrimeReconciliationReceipt {
    return this.db.transaction(() => {
      const { request, terminal, terminalDigest } = this.reconciliationCandidate(input.operationId);
      if (input.terminalReceiptId !== terminal.receiptId || input.terminalDigest !== terminalDigest ||
        request.authorityDigest !== input.proof.authorityDigest ||
        request.identity.runId !== input.proof.runId || input.operationId !== input.proof.operationId ||
        input.requestId !== input.proof.targetRequestId ||
        input.requestDigest !== input.proof.targetRequestDigest ||
        input.proof.kind !== "non_admission" || input.proof.state !== "not_admitted" ||
        input.proof.fence !== "stopped" || input.proof.targetMethod !== "paperclip.request")
        throw new Error("Non-admission proof differs from the original Prime operation");
      const existing = this.reconciliation(input.operationId);
      if (existing) {
        if (existing.originalTerminalReceiptId !== input.terminalReceiptId ||
          existing.originalTerminalDigest !== terminalDigest ||
          existing.originalRequestId !== input.requestId ||
          existing.originalRequestDigest !== input.requestDigest ||
          canonical(existing.nonAdmission) !== canonical(input.proof))
          throw new Error("Prime reconciliation conflicts with an immutable receipt");
        return existing;
      }
      const effect = this.db.prepare(`SELECT state, request_digest FROM prime_ipc_effects
        WHERE operation_id = ? AND request_id = ?`).get(input.operationId, input.requestId) as
        { state: string; request_digest: string } | undefined;
      const unresolved = this.db.prepare(`SELECT count(*) AS count FROM prime_ipc_effects
        WHERE operation_id = ? AND request_id <> ? AND state <> 'final'`)
        .get(input.operationId, input.requestId) as { count: number };
      const lease = this.db.prepare(`SELECT workspace_root, run_id, writer_kind, state FROM prime_writer_leases
        WHERE operation_id = ?`).get(input.operationId) as
        { workspace_root: string; run_id: string; writer_kind: string; state: string } | undefined;
      if (effect?.state !== "uncertain" || effect.request_digest !== input.requestDigest ||
        unresolved.count !== 0 || lease?.workspace_root !== request.workspace.realRoot ||
        lease.run_id !== request.identity.runId || lease.writer_kind !== "paperclip_prime" ||
        lease.state !== "uncertain")
        throw new Error("Prime recovery has another unresolved effect or no matching held writer");
      const settlement: PrimeSettlement = {
        provider: terminal.settlement.provider,
        worker: terminal.settlement.worker,
        descendants: terminal.settlement.descendants,
        governedActions: "settled",
        evidence: [...terminal.settlement.evidence,
          `host non-admission ${input.proof.proofRequestId} for ${input.requestId}`],
      };
      if (!settlementProvesRelease(settlement))
        throw new Error("Prime reconciliation lacks complete settlement");
      const receiptId = createHash("sha256").update(canonical({
        kind: "prime_reconciliation", operationId: input.operationId,
        terminalReceiptId: terminal.receiptId, requestId: input.requestId,
        requestDigest: input.requestDigest,
      })).digest("hex");
      const receipt: Omit<PrimeReconciliationReceipt, "hostHandoff"> = {
        receiptId, operationId: input.operationId,
        originalTerminalReceiptId: terminal.receiptId,
        originalTerminalDigest: terminalDigest,
        originalRequestId: input.requestId, originalRequestDigest: input.requestDigest,
        authorityDigest: request.authorityDigest, settlement, nonAdmission: input.proof,
      };
      this.db.prepare(`INSERT INTO prime_run_reconciliations
        (operation_id, receipt_id, original_terminal_receipt_id, original_terminal_digest,
        original_request_id, original_request_digest, authority_digest, receipt_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.operationId, receiptId, terminal.receiptId, terminalDigest, input.requestId,
          input.requestDigest, request.authorityDigest, JSON.stringify(receipt), this.now().toISOString());
      const released = this.db.prepare(`DELETE FROM prime_writer_leases
        WHERE operation_id = ? AND workspace_root = ? AND run_id = ? AND writer_kind = 'paperclip_prime'`)
        .run(input.operationId, request.workspace.realRoot, request.identity.runId);
      if (released.changes !== 1) throw new Error("Prime recovery could not release its own writer");
      return { ...receipt, hostHandoff: null };
    }).immediate();
  }

  appendReconciliationHandoff(operationId: string, proof: PrimeWorkerReconciliationProof):
    PrimeReconciliationReceipt {
    return this.db.transaction(() => {
      const receipt = this.reconciliation(operationId);
      if (!receipt || proof.kind !== "worker_reconciliation" || proof.state !== "settled" ||
        proof.operationId !== operationId ||
        proof.runId !== this.identity(operationId)?.runId ||
        proof.authorityDigest !== receipt.authorityDigest ||
        proof.terminalReceiptId !== receipt.originalTerminalReceiptId ||
        proof.worker !== "stopped" || proof.descendants !== "stopped")
        throw new Error("Host worker proof differs from the immutable reconciliation");
      if (receipt.hostHandoff) {
        if (canonical(receipt.hostHandoff) !== canonical(proof))
          throw new Error("Host worker handoff proof conflicts with the durable receipt");
        return receipt;
      }
      this.db.prepare(`INSERT INTO prime_run_reconciliation_handoffs
        (operation_id, proof_json, created_at) VALUES (?, ?, ?)`)
        .run(operationId, JSON.stringify(proof), this.now().toISOString());
      return { ...receipt, hostHandoff: proof };
    }).immediate();
  }

  recoveryEffect(operationId: string, requestId: string): { state: string; digest: string } | null {
    const row = this.db.prepare(`SELECT state, request_digest FROM prime_ipc_effects
      WHERE operation_id = ? AND request_id = ?`).get(operationId, requestId) as
      { state: string; request_digest: string } | undefined;
    return row ? { state: row.state, digest: row.request_digest } : null;
  }

  unsettledEffectCount(operationId: string): number {
    const row = this.db.prepare(
      "SELECT count(*) AS count FROM prime_ipc_effects WHERE operation_id = ? AND state <> 'final'",
    ).get(operationId) as { count: number };
    return row.count;
  }

  ownsRequest(operationId: string, targetRequestId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM prime_ipc_effects WHERE operation_id = ? AND request_id = ?")
        .get(operationId, targetRequestId) !== undefined
    );
  }

  reserve(
    operationId: string,
    requestId: string,
    requestDigest: string,
  ): PrimeRestrictedIpcReservation {
    const at = this.now().toISOString();
    return this.db
      .transaction((): PrimeRestrictedIpcReservation => {
        const existing = this.db
          .prepare(
            `SELECT request_digest, state, response_json FROM prime_ipc_effects
         WHERE operation_id = ? AND request_id = ?`,
          )
          .get(operationId, requestId) as
          | {
              request_digest: string;
              state: "reserved" | "final" | "uncertain";
              response_json: string | null;
            }
          | undefined;
        if (existing) {
          if (existing.request_digest !== requestDigest) {
            throw new Error("restricted IPC request id was reused with different arguments");
          }
          if (existing.response_json) {
            return {
              state: existing.state === "final" ? "final" : "uncertain",
              response: JSON.parse(existing.response_json) as PrimeRestrictedIpcResponse[],
            };
          }
          // A durable reservation without a receipt may already have crossed the
          // provider boundary before this process lost ownership. Never redispatch.
          const response: PrimeRestrictedIpcResponse[] = [
            {
              version: 2,
              requestId,
              sequence: 0,
              kind: "error",
              error: {
                code: "request_outcome_uncertain",
                message: "Prior owner lost this reserved request",
              },
            },
          ];
          this.db
            .prepare(
              `UPDATE prime_ipc_effects SET state = 'uncertain', response_json = ?, updated_at = ?
           WHERE operation_id = ? AND request_id = ?`,
            )
            .run(JSON.stringify(response), at, operationId, requestId);
          return { state: "uncertain", response };
        }
        this.db
          .prepare(
            `INSERT INTO prime_ipc_effects
         (operation_id, request_id, request_digest, state, response_json, created_at, updated_at)
         VALUES (?, ?, ?, 'reserved', NULL, ?, ?)`,
          )
          .run(operationId, requestId, requestDigest, at, at);
        return { state: "reserved" };
      })
      .immediate();
  }

  finalize(
    operationId: string,
    requestId: string,
    requestDigest: string,
    response: PrimeRestrictedIpcResponse[],
  ): void {
    this.completeIpcEffect(operationId, requestId, requestDigest, "final", response);
  }

  markUncertain(
    operationId: string,
    requestId: string,
    requestDigest: string,
    response: PrimeRestrictedIpcResponse[],
  ): void {
    this.completeIpcEffect(operationId, requestId, requestDigest, "uncertain", response);
  }

  private completeIpcEffect(
    operationId: string,
    requestId: string,
    requestDigest: string,
    state: "final" | "uncertain",
    response: PrimeRestrictedIpcResponse[],
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE prime_ipc_effects SET state = ?, response_json = ?, updated_at = ?
       WHERE operation_id = ? AND request_id = ? AND request_digest = ? AND state = 'reserved'`,
      )
      .run(
        state,
        JSON.stringify(response),
        this.now().toISOString(),
        operationId,
        requestId,
        requestDigest,
      ).changes;
    if (changed !== 1) throw new Error("restricted IPC reservation is not owned");
  }
}
