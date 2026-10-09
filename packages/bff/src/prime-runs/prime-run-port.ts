import { isAbsolute, join, relative, sep } from "node:path";
import type { PrimeRunEvent,
PrimeRunIdentity,
PrimeRunRequest,
PrimeSettlement, } from "@deepextrema/paperclip-primeagent-adapter"


/** Managed input aliases below the writable workspace must resolve to the same
 * immutable snapshots as their /opt/paperclip paths, not the writable originals. */
export function managedWorkspaceAliases(request: PrimeRunRequest, ipcDirectory: string): Array<{
  original: string;
  snapshot: string;
}> {
  const candidates = [
    ...request.managedSkills.map((skill, index) => ({
      original: skill.path, snapshot: join(ipcDirectory, "skills", String(index)),
      directory: true,
    })),
    { original: request.managedInstructions.sourcePath,
      snapshot: join(ipcDirectory, "managed-instructions.md"), directory: false },
  ];
  const protectedAliases = [];
  for (const candidate of candidates) {
    const within = relative(request.workspace.realRoot, candidate.original);
    if (!within && candidate.directory)
      throw new Error("managed skill cannot make the entire writable workspace read-only");
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
    protectedAliases.push(candidate);
  }
  protectedAliases.sort((left, right) => left.original.length - right.original.length);
  return protectedAliases;
}
export interface VerifiedPaperclipRun extends PrimeRunIdentity {
  /** The verifier observed this exact signed run identity at this instant. */
  verifiedAt: string;
  workspaceId: string;
  executionWorkspaceId: string;
  workspaceRoot: string;
  mcpConnectionIds: string[];
  authorityDigest: string;
}

export interface PaperclipRunIdentityVerifier {
  verify(input: {
    bearerToken: string;
    runId: string;
    request: PrimeRunRequest;
  }): Promise<VerifiedPaperclipRun>;
  /** Constrained Paperclip broker; host-only capabilities never enter the worker manifest. */
  broker(runId: string, bearerToken: string, request: unknown): AsyncIterable<unknown>;
  verifyActor(input: {
    bearerToken: string;
    runId: string;
    operationId: string;
    expected?: PrimeRunIdentity;
  }): Promise<PrimeRunIdentity & { operationId: string; authorityDigest: string; controlDeadlineAt: string }>;
}

export interface PrimeContainedWorker {
  /**
   * Start or resume one contained worker and yield lossless run events.
   * The worker receives only the validated launch manifest. Browser state,
   * arbitrary environment entries, daemon socket paths, and BFF credentials
   * never cross this port.
   */
  execute(
    request: PrimeRunRequest, signal: AbortSignal,
    broker: (request: unknown, purpose: "execute" | "control") => AsyncIterable<unknown>,
  ): AsyncIterable<PrimeRunEvent>;

  /**
   * Stop only the worker owned by operationId. `uncertain` means no replacement
   * run may be admitted until an operator reconciles the original worker.
   */
  cancel(operationId: string): Promise<PrimeSettlement | "not_found">;

  /** Reconcile only a worker this instance can positively identify. */
  reconcile(operationId: string): Promise<PrimeSettlement | "not_found">;
}

export interface PrimeRunStartInput {
  bearerToken: string;
  headerRunId: string;
  controlBearerToken: string;
  request: unknown;
}

export type PrimeRunStopResult =
  | { outcome: "stopped"; settlement: PrimeSettlement }
  | { outcome: "uncertain" | "not_found"; settlement: null };

export interface PrimeRunSurface {
  start(input: PrimeRunStartInput): Promise<AsyncIterable<PrimeRunEvent>>;
  cancel(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
  }): Promise<PrimeRunStopResult>;
  observe(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
    afterSequence: number;
  }): Promise<PrimeRunEvent[]>;
  reconcile(input: {
    bearerToken: string;
    headerRunId: string;
    operationId: string;
  }): Promise<"stopped" | "not_found" | "uncertain">;
}

export class PrimeRunBoundaryError extends Error {
  constructor(
    readonly kind: "unauthorized" | "invalid" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
