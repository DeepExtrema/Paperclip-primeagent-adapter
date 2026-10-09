import type {
  AdapterExecutionContext as PaperclipExecutionContext,
  AdapterExecutionResult as PaperclipExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  PRIME_BFF_ADAPTER_TYPE,
  PRIME_CONTAINMENT_PROFILE,
  PRIME_PROVIDER,
  type PrimeRunEvent,
  type PrimeRunRequest,
  type PrimeSettlement,
  type PrimeRunSessionParams,
  parsePrimeRunEvent,
  parsePrimeRunRequest,
  type PrimeRuntimeAuthority,
  parsePrimeRunSessionParams,
  settlementProvesRelease,
} from "./protocol.js";

/** Stock Paperclip types plus the required final-realization host hook.
 * The patched Paperclip host MUST supply this hook; a missing hook fails before dispatch. */
export type PrimeHostExecutionContext = PaperclipExecutionContext & {
  signal?: AbortSignal;
  onEvent?: (event: {
    eventType: string;
    level?: "info" | "warn" | "error";
    message?: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  onCancellationReady?: () => Promise<void>;
  onProviderStopped?: () => Promise<void>;
  onDispatch?: () => void;
  primeRuntime?: {
    executeCapability: string;
    controlCapability: string;
    authorityDigest: string;
    authority: PrimeRuntimeAuthority;
    finalize(input: {
      intentId: string; issueId: string; status: "blocked" | "in_review" | "done";
      summary: string; operationId: string; terminalReceiptId: string;
    }): Promise<void>;
  };
};
/** Add only the recovery/accounting fields absent from the published adapter result. */
export type PrimeHostExecutionResult = PaperclipExecutionResult & {
  executionRecovery?:
    | { kind: "bootstrap"; providerWorkStarted: false }
    | { kind: "interrupted"; providerStopped: true; sessionPreserved: true; actionOutcomes: "settled" };
  usageBasis?: "per_run" | "session_cumulative" | null;
  biller?: string | null;
  billingType?: "subscription";
};

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveBffBaseUrl(config: Record<string, unknown>): string {
  const raw = nonEmptyString(config.bffBaseUrl) ?? "http://127.0.0.1:4319";
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("prime_bff requires a credential-free loopback HTTP bffBaseUrl");
  }
  return url.origin;
}

function buildRequest(
  ctx: PaperclipExecutionContext,
  authority: PrimeRuntimeAuthority,
  authorityDigest: string,
  previousSession: PrimeRunSessionParams | null,
): PrimeRunRequest {
  if (authority.identity.runId !== ctx.runId ||
    authority.identity.agentId !== ctx.agent.id ||
    authority.identity.companyId !== ctx.agent.companyId ||
    authority.operationId !== ctx.runId)
    throw new Error("final Paperclip authority is not assigned to this adapter run");
  const prompt = authority.prompt;
  return {
    version: 3,
    authorityDigest,
    authority,
    operationId: authority.operationId,
    turnId: authority.turnId,
    identity: {
      companyId: authority.identity.companyId,
      agentId: authority.identity.agentId,
      issueId: authority.identity.issueId,
      runId: authority.identity.runId,
    },
    workspace: { ...authority.workspace, mode: "workspace-write" },
    containment: authority.containment,
    model: {
      provider: PRIME_PROVIDER, id: authority.selection.model,
      billingType: "subscription", allowFallback: false,
    },
    prompt,
    managedInstructions: authority.instructions,
    managedSkills: authority.skills,
    managedMcp: authority.mcp,
    previousSession,
    deadlineAt: authority.executeDeadlineAt,
  };
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line) as unknown;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield JSON.parse(buffered) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function terminalResult(
  event: Extract<PrimeRunEvent, { type: "terminal" }>,
): PrimeHostExecutionResult {
  const stopped = settlementProvesRelease(event.settlement);
  const shared = {
    signal: event.outcome === "cancelled" ? "SIGTERM" : null,
    timedOut: false,
    ...(event.usage === null ? {} : { usage: event.usage, usageBasis: "per_run" as const }),
    sessionParams: event.outcome === "completed"
      ? event.session as unknown as Record<string, unknown> : null,
    sessionDisplayId: event.session.primeSessionId,
    provider: PRIME_PROVIDER,
    biller: "chatgpt",
    billingType: event.route.billingType,
    model: event.route.model,
    costUsd: null,
    summary: event.summary,
    resultJson: {
      outcome: event.outcome,
      settlement: event.settlement,
      route: event.route,
      session: event.session,
    },
  };
  switch (event.outcome) {
    case "completed":
      return { ...shared, exitCode: 0 };
    case "cancelled":
      return {
        ...shared,
        exitCode: null,
        ...(stopped
          ? {
              executionRecovery: {
                kind: "interrupted" as const,
                providerStopped: true as const,
                sessionPreserved: true as const,
                actionOutcomes: "settled" as const,
              },
            }
          : {}),
      };
    case "failed":
      return {
        ...shared,
        exitCode: 1,
        errorCode: event.errorCode ?? "prime_run_failed",
        errorMessage: event.summary ?? "Prime run failed",
      };
    case "uncertain":
      return {
        ...shared,
        exitCode: null,
        errorCode: event.errorCode ?? "prime_run_uncertain",
        errorMessage: event.summary ?? "Prime run outcome is uncertain",
      };
  }
}

function bootstrapFailure(error: unknown): PrimeHostExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "prime_bff_preflight_failed",
    errorMessage: message,
    clearSession: false,
  };
}

function originalOwnerStopSettlement(
  response: unknown, operationId: string,
): PrimeSettlement | null {
  const receipt = objectValue(response);
  if (receipt.operationId !== operationId || receipt.stopped !== true ||
    receipt.outcome !== "stopped") return null;
  const proof = objectValue(receipt.settlement);
  if (proof.provider !== "settled" || proof.governedActions !== "settled" ||
    proof.worker !== "stopped" || proof.descendants !== "stopped" ||
    !Array.isArray(proof.evidence) || proof.evidence.length === 0 ||
    proof.evidence.length > 32 || !proof.evidence.every(
      (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4096,
    )) return null;
  return {
    provider: "settled",
    governedActions: "settled",
    worker: "stopped",
    descendants: "stopped",
    evidence: [...proof.evidence] as string[],
  };
}

function cancelledWithOwnerProof(settlement: PrimeSettlement): PrimeHostExecutionResult {
  return {
    executionRecovery: {
      kind: "interrupted",
      providerStopped: true,
      sessionPreserved: true,
      actionOutcomes: "settled",
    },
    resultJson: { outcome: "cancelled", settlement },
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
    errorCode: "prime_run_cancelled",
    errorMessage: "Prime run was cancelled and confirmed stopped",
  };
}

export async function execute(ctx: PrimeHostExecutionContext): Promise<PrimeHostExecutionResult> {
  let request: PrimeRunRequest;
  let baseUrl: string;
  try {
    if (!ctx.primeRuntime?.executeCapability || !ctx.primeRuntime.controlCapability)
      throw new Error("prime_bff requires distinct final-realization execute and control capabilities");
    if (!ctx.signal || !ctx.onCancellationReady || !ctx.onProviderStopped || !ctx.onDispatch)
      throw new Error("prime_bff requires host cancellation, dispatch and provider-stop lifecycle hooks");
    if (nonEmptyString(ctx.config.model) !== null &&
      ctx.config.model !== ctx.primeRuntime.authority.selection.model)
      throw new Error("prime_bff model config differs from host-selected model");
    if (ctx.signal?.aborted) throw new Error("prime_bff run was cancelled before dispatch");
    baseUrl = resolveBffBaseUrl(ctx.config);
    const previousSession = ctx.runtime.sessionParams === null
      ? null : parsePrimeRunSessionParams(ctx.runtime.sessionParams);
    const authority = ctx.primeRuntime.authority;
    request = parsePrimeRunRequest(buildRequest(ctx, authority, ctx.primeRuntime.authorityDigest, previousSession));
    await ctx.onCancellationReady();
  } catch (error) {
    return bootstrapFailure(error);
  }

  const executeHeaders = {
    authorization: `Bearer ${ctx.primeRuntime!.executeCapability}`,
    "x-paperclip-prime-control-capability": ctx.primeRuntime!.controlCapability,
    "content-type": "application/json",
    "x-paperclip-run-id": ctx.runId,
  };
  const controlHeaders = {
    authorization: `Bearer ${ctx.primeRuntime!.controlCapability}`,
    "x-paperclip-run-id": ctx.runId,
  };
  await ctx.onMeta?.({
    adapterType: PRIME_BFF_ADAPTER_TYPE,
    command: "paperclip-primeagent-bff-run",
    cwd: request.workspace.root,
    commandNotes: [
      `provider=${PRIME_PROVIDER}`,
      `model=${request.model.id}`,
      `containment=${PRIME_CONTAINMENT_PROFILE}`,
    ],
    context: {
      issueId: request.identity.issueId,
      resumed: request.previousSession !== null,
      managedMcpConnections: [...new Set(request.managedMcp.tools.map((tool) => tool.connectionId))],
    },
  });

  let cancelPromise: Promise<PrimeSettlement | null> | null = null;
  const cancel = () => {
    if (cancelPromise !== null) return;
    cancelPromise = fetch(
      `${baseUrl}/internal/paperclip/prime-runs/${encodeURIComponent(ctx.runId)}`,
      { method: "DELETE", headers: controlHeaders },
    )
      .then(async (response) =>
        response.ok
          ? originalOwnerStopSettlement(await response.json(), request.operationId)
          : null)
      .catch(() => null);
  };
  ctx.signal?.addEventListener("abort", cancel, { once: true });

  let dispatched = false;
  try {
    ctx.onDispatch?.();
    dispatched = true;
    const response = await fetch(`${baseUrl}/internal/paperclip/prime-runs`, {
      method: "POST",
      headers: executeHeaders,
      body: JSON.stringify(request),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (!response.ok || response.body === null) {
      const message = (await response.text()).slice(0, 2048);
      return {
        ...(dispatched ? {} : { executionRecovery: { kind: "bootstrap" as const, providerWorkStarted: false as const } }),
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: response.status === 409 ? "prime_run_refused" : "prime_run_unavailable",
        errorMessage: message || `Prime BFF returned HTTP ${response.status}`,
        clearSession: false,
      };
    }
    let terminal: Extract<PrimeRunEvent, { type: "terminal" }> | null = null;
    let acceptedSession: string | null = null;
    let lastSequence = -1;
    for await (const raw of ndjson(response.body)) {
      const event = parsePrimeRunEvent(raw);
      if (event.turnId !== request.turnId || event.sequence <= lastSequence || terminal !== null)
        throw new Error("Prime BFF streamed an out-of-scope or unordered receipt");
      lastSequence = event.sequence;
      if (event.type === "accepted") {
        if (acceptedSession !== null || event.operationId !== request.operationId ||
          event.resumed !== (request.previousSession !== null) ||
          request.previousSession !== null &&
            event.primeSessionId !== request.previousSession.primeSessionId)
          throw new Error("Prime BFF accepted an unexpected native session");
        acceptedSession = event.primeSessionId;
      } else if (acceptedSession === null)
        throw new Error("Prime BFF emitted work without an accepted session");
      if (event.type === "log") await ctx.onLog(event.stream, event.message);
      else if (event.type === "message") {
        await ctx.onEvent?.({
          eventType: "message",
          level: "info",
          message: event.content,
          payload: {
            sequence: event.sequence,
            receiptId: event.receiptId,
            messageId: event.messageId,
            role: event.role,
          },
        });
      } else if (event.type === "tool_effect") {
        await ctx.onEvent?.({
          eventType: "tool_effect",
          level: event.phase === "failed" ? "error" : "info",
          message: `${event.toolName}: ${event.phase}`,
          payload: {
            sequence: event.sequence,
            receiptId: event.receiptId,
            effectId: event.effectId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: event.phase,
            replaySafe: event.replaySafe,
          },
        });
      } else if (event.type === "approval_wait") {
        await ctx.onEvent?.({
          eventType: "approval_wait",
          level: "info",
          message: `Waiting for Paperclip approval for ${event.tool}`,
          payload: {
            invocationId: event.invocationId,
            actionRequestId: event.actionRequestId,
            interactionId: event.interactionId,
            formalApprovalId: event.formalApprovalId,
            issueId: event.issueId,
            tool: event.tool,
            argumentsHash: event.argumentsHash,
          },
        });
      } else if (event.type === "checkpoint") {
        await ctx.onEvent?.({
          eventType: "checkpoint",
          level: "info",
          payload: { sequence: event.sequence, checkpoint: event.checkpoint },
        });
      } else if (event.type === "terminal") terminal = event;
    }
    if (terminal !== null) {
      if (terminal.route.model !== request.model.id ||
        terminal.session.namespace !== request.authority.session.namespace ||
        terminal.session.companyId !== request.identity.companyId ||
        terminal.session.agentId !== request.identity.agentId ||
        terminal.session.issueId !== request.identity.issueId ||
        terminal.session.workspaceRoot !== request.workspace.realRoot ||
        terminal.session.connectionId !== request.authority.selection.connectionId ||
        terminal.session.primeSessionId !== acceptedSession)
        throw new Error("Prime BFF terminal escaped host-authorized scope");
      if (settlementProvesRelease(terminal.settlement))
        await ctx.onProviderStopped?.();
      if (terminal.outcome === "completed" && terminal.finalization !== null) {
        if (terminal.finalization.issueId !== request.identity.issueId ||
          !settlementProvesRelease(terminal.settlement))
          throw new Error("Prime BFF finalization lacks own-issue settled proof");
        await ctx.primeRuntime!.finalize({
          ...terminal.finalization, operationId: request.operationId,
          terminalReceiptId: terminal.receiptId,
        });
      }
      return terminalResult(terminal);
    }
    const stopProof = cancelPromise === null ? null : await cancelPromise;
    if (ctx.signal?.aborted && stopProof !== null)
      return cancelledWithOwnerProof(stopProof);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "prime_run_uncertain",
      errorMessage: "Prime run stream ended without a terminal receipt",
      clearSession: false,
    };
  } catch (error) {
    const stopProof = cancelPromise === null ? null : await cancelPromise;
    if (ctx.signal?.aborted && stopProof !== null)
      return cancelledWithOwnerProof(stopProof);
    return {
      ...(dispatched
        ? {}
        : { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } as const }),
      exitCode: dispatched ? null : 1,
      signal: null,
      timedOut: false,
      errorCode: dispatched ? "prime_run_uncertain" : "prime_bff_preflight_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      clearSession: false,
    };
  } finally {
    ctx.signal?.removeEventListener("abort", cancel);
  }
}

const HOST_SESSION_METADATA_KEYS: Record<string, true> = {
  paperclipAiCredentialIdentity: true,
  __paperclipConfiguredModel: true,
  __paperclipConfigFingerprint: true,
  __paperclipConfigFingerprintVersion: true,
  __paperclipConfigCategories: true,
  __paperclipConfigCategoryFingerprints: true,
};

export const sessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const session = Object.fromEntries(Object.entries(raw).filter(
        ([key]) => !Object.hasOwn(HOST_SESSION_METADATA_KEYS, key),
      ));
      if (Object.keys(session).length === 0) return null;
      return parsePrimeRunSessionParams(session) as unknown as Record<string, unknown>;
    }
    return parsePrimeRunSessionParams(raw) as unknown as Record<string, unknown>;
  },
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (params === null) return null;
    return parsePrimeRunSessionParams(params) as unknown as Record<string, unknown>;
  },
  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (params === null) return null;
    return parsePrimeRunSessionParams(params).primeSessionId;
  },
};

export function createServerAdapter() {
  return {
    type: PRIME_BFF_ADAPTER_TYPE,
    execute,
    sessionCodec,
    supportsLocalAgentJwt: false,
    runtimeToolDelivery: "invocation_context" as const,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    listSkills: async (ctx: { config: Record<string, unknown> }) => {
      const configured = Array.isArray(ctx.config.paperclipRuntimeSkills)
        ? ctx.config.paperclipRuntimeSkills : [];
      const entries = configured.flatMap((raw) => {
        const entry = objectValue(raw);
        const key = nonEmptyString(entry.key) ?? nonEmptyString(entry.name);
        const runtimeName = nonEmptyString(entry.runtimeName) ?? nonEmptyString(entry.name);
        if (key === null || runtimeName === null) return [];
        const missing = entry.sourceStatus === "missing";
        return [{
          key, runtimeName,
          versionId: nonEmptyString(entry.versionId),
          currentVersionId: nonEmptyString(entry.currentVersionId),
          desired: true,
          managed: true,
          origin: "company_managed" as const,
          state: missing ? "missing" as const : "configured" as const,
          sourcePath: missing ? null : nonEmptyString(entry.source),
          targetPath: null,
          detail: missing
            ? nonEmptyString(entry.missingDetail) ?? "The assigned Paperclip skill source is unavailable."
            : "Materialized and attested only at run admission by the Paperclip host.",
        }];
      });
      return {
        adapterType: PRIME_BFF_ADAPTER_TYPE,
        supported: true,
        mode: "ephemeral" as const,
        desiredSkills: entries.map((entry) => entry.key),
        desiredSkillEntries: entries.map(({ key, versionId }) => ({ key, versionId })),
        entries,
        warnings: ["Skill source availability and versions are revalidated at each managed run admission."],
      };
    },
    testEnvironment: async (ctx: { config: Record<string, unknown> }) => {
      const checks: Array<{
        code: string;
        level: "info" | "warn" | "error";
        message: string;
        detail?: string;
      }> = [];
      try {
        const baseUrl = resolveBffBaseUrl(ctx.config);
        const response = await fetch(`${baseUrl}/internal/paperclip/prime-runs/capabilities`, {
          signal: AbortSignal.timeout(2_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`BFF capability probe returned HTTP ${response.status}`);
        const capabilities = objectValue(await response.json());
        if (capabilities.protocolVersion !== 3 ||
          capabilities.containmentProfile !== PRIME_CONTAINMENT_PROFILE)
          throw new Error("BFF does not expose the assigned Prime v3 containment surface");
        checks.push({
          code: "prime_bff_available",
          level: "info",
          message: "Contained Prime run surface is reachable on the configured loopback port",
        });
      } catch (error) {
        checks.push({
          code: "prime_bff_available",
          level: "error",
          message: "Contained Prime run surface is not reachable",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      checks.push({
        code: "prime_bff_authenticated_catalog",
        level: "warn",
        message: "Host subscription catalog and assigned model are verified at managed run admission",
      });
      return {
        adapterType: PRIME_BFF_ADAPTER_TYPE,
        status: checks.some((check) => check.level === "error") ? "fail" : "warn",
        checks,
        testedAt: new Date().toISOString(),
      };
    },
    getConfigSchema: () => ({
      fields: [
        {
          key: "bffBaseUrl",
          label: "Standalone Prime BFF URL",
          type: "text" as const,
          default: "http://127.0.0.1:4319",
          required: true,
          hint: "Loopback HTTP only; the adapter never accepts credentials in this URL.",
        },
        {
          key: "cwd",
          label: "Workspace",
          type: "text" as const,
          required: true,
        },
        {
          key: "model",
          label: "Host-authorized OpenAI subscription model",
          type: "text" as const,
          required: true,
          hint: "Exact model selected on this agent in Paperclip; authenticated catalog admission happens per run.",
        },
      ],
    }),
    agentConfigurationDoc: "prime_bff uses host-authorized OpenAI subscription model selection, BFF-owned settled native checkpoints and governed Paperclip tools. It does not change existing agents or defaults.",
  } satisfies ServerAdapterModule & Record<string, unknown>;
}

export * from "./protocol.js";
