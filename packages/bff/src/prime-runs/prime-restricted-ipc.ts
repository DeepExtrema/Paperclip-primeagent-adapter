import { createHash } from "node:crypto";
import { type PrimeRuntimeAuthority,
primeCanonicalDigest, } from "@deepextrema/paperclip-primeagent-adapter"

export const PRIME_RESTRICTED_IPC_VERSION = 2 as const;
export const PRIME_RESTRICTED_PROVIDER = "openai-codex" as const;
export const PRIME_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PRIME_MAX_BROKER_RESPONSE_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

export type PrimeRestrictedIpcAuthority = PrimeRuntimeAuthority & { authorityDigest: string };
export type PrimeRestrictedIpcPayload =
  | { method: "provider.catalog" }
  | { method: "provider.stream"; turnId: string; request: Record<string, unknown> }
  | { method: "provider.status" | "provider.abort" | "effect.status"; targetRequestId: string }
  | { method: "mcp.tools.list"; connectionId: string }
  | {
      method: "mcp.tools.call";
      connectionId: string;
      tool: string;
      arguments: Record<string, unknown>;
    }
  | { method: "paperclip.request"; httpMethod: "GET" | "POST" | "PATCH" | "PUT"; path: string; body?: unknown }
  | { method: "paperclip.finish"; status: "blocked" | "in_review" | "done"; summary: string }
  | { method: "operation.stop" | "operation.status" };
const BROKER_RESULT_BY_METHOD: Record<PrimeRestrictedIpcPayload["method"], string> = {
  "provider.catalog": "catalog",
  "provider.stream": "provider",
  "provider.status": "provider",
  "provider.abort": "provider",
  "mcp.tools.list": "mcp_tools",
  "mcp.tools.call": "effect",
  "effect.status": "effect",
  "paperclip.request": "paperclip",
  "paperclip.finish": "finalization",
  "operation.stop": "operation",
  "operation.status": "operation",
};
export interface PrimeRestrictedIpcRequest {
  version: 2;
  authorityDigest: string;
  operationId: string;
  requestId: string;
  payload: PrimeRestrictedIpcPayload;
}
export type PrimeRestrictedIpcResponse =
  | {
      version: 2;
      requestId: string;
      sequence: number;
      kind: "provider_event";
      event: Record<string, unknown>;
    }
  | {
      version: 2;
      requestId: string;
      sequence: number;
      kind: "result";
      result: Record<string, unknown>;
    }
  | {
      version: 2;
      requestId: string;
      sequence: number;
      kind: "error";
      error: { code: string; message: string };
    };
export type PrimeRestrictedIpcReservation =
  | { state: "reserved" }
  | { state: "final" | "uncertain"; response: PrimeRestrictedIpcResponse[] };
export interface PrimeRestrictedIpcStore {
  reserve(
    operationId: string,
    requestId: string,
    requestDigest: string,
  ): PrimeRestrictedIpcReservation;
  ownsRequest(operationId: string, targetRequestId: string): boolean;
  finalize(
    operationId: string,
    requestId: string,
    requestDigest: string,
    response: PrimeRestrictedIpcResponse[],
  ): void;
  markUncertain(
    operationId: string,
    requestId: string,
    requestDigest: string,
    response: PrimeRestrictedIpcResponse[],
  ): void;
}
export interface PrimeRestrictedIpcHandlers {
  broker(
    request: PrimeRestrictedIpcRequest,
    purpose: "execute" | "control",
  ): AsyncIterable<unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${label} has an unauthorized field`);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function parsePrimeRestrictedIpcRequest(value: unknown): PrimeRestrictedIpcRequest {
  const input = record(value, "request");
  exact(input, ["version", "authorityDigest", "operationId", "requestId", "payload"], "request");
  if (input.version !== 2) throw new Error("restricted IPC version unsupported");
  const payload = record(input.payload, "payload");
  const method = payload.method;
  let parsed: PrimeRestrictedIpcPayload;
  if (
    method === "provider.catalog" ||
    method === "operation.stop" ||
    method === "operation.status"
  ) {
    exact(payload, ["method"], "payload");
    parsed = { method };
  } else if (method === "provider.stream") {
    exact(payload, ["method", "turnId", "request"], "payload");
    const request = record(payload.request, "payload.request");
    if (
      Object.keys(request).some(
        (key) =>
          ![
            "model",
            "store",
            "stream",
            "instructions",
            "input",
            "text",
            "include",
            "prompt_cache_key",
            "tool_choice",
            "parallel_tool_calls",
            "tools",
            "reasoning",
            "temperature",
            "service_tier",
          ].includes(key),
      ) ||
      typeof request.model !== "string" ||
      request.store !== false ||
      request.stream !== true ||
      !Array.isArray(request.input) ||
      (request.tool_choice !== undefined && request.tool_choice !== "auto") ||
      (request.service_tier !== undefined && request.service_tier !== "default") ||
      (request.temperature !== undefined &&
        (typeof request.temperature !== "number" ||
          !Number.isFinite(request.temperature) ||
          request.temperature < 0 ||
          request.temperature > 2)) ||
      (request.text !== undefined &&
        (!request.text ||
          typeof request.text !== "object" ||
          Array.isArray(request.text) ||
          Object.keys(request.text).some((key) => key !== "verbosity") ||
          !["low", "medium", "high"].includes(
            String((request.text as Record<string, unknown>).verbosity),
          ))) ||
      (request.include !== undefined &&
        (!Array.isArray(request.include) ||
          request.include.length !== 1 ||
          request.include[0] !== "reasoning.encrypted_content"))
    )
      throw new Error("provider request must use exact foreground subscription Responses schema");
    if (request.reasoning !== undefined) {
      const reasoning = record(request.reasoning, "provider reasoning");
      exact(reasoning, ["effort", "summary"], "provider reasoning");
      if (
        !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          String(reasoning.effort),
        ) ||
        !["auto", "concise", "detailed", "off", "on"].includes(String(reasoning.summary))
      )
        throw new Error("provider reasoning mode is not assigned");
    }
    parsed = { method, turnId: identifier(payload.turnId, "payload.turnId"), request };
  } else if (
    method === "provider.status" ||
    method === "provider.abort" ||
    method === "effect.status"
  ) {
    exact(payload, ["method", "targetRequestId"], "payload");
    parsed = {
      method,
      targetRequestId: identifier(payload.targetRequestId, "payload.targetRequestId"),
    };
  } else if (method === "mcp.tools.list") {
    exact(payload, ["method", "connectionId"], "payload");
    parsed = { method, connectionId: identifier(payload.connectionId, "payload.connectionId") };
  } else if (method === "mcp.tools.call") {
    exact(payload, ["method", "connectionId", "tool", "arguments"], "payload");
    const args = record(payload.arguments, "payload.arguments");
    parsed = {
      method,
      connectionId: identifier(payload.connectionId, "payload.connectionId"),
      tool: identifier(payload.tool, "payload.tool"),
      arguments: args,
    };
  } else if (method === "paperclip.request") {
    exact(payload, ["method", "httpMethod", "path", "body"], "payload");
    if (!["GET", "POST", "PATCH", "PUT"].includes(String(payload.httpMethod)) ||
      typeof payload.path !== "string" || !/^\/api\/[a-zA-Z0-9/_-]+$/.test(payload.path) ||
      payload.path.length > 1024 || payload.path.includes("//") ||
      payload.body !== undefined && Buffer.byteLength(JSON.stringify(payload.body)) > PRIME_MAX_FRAME_BYTES)
      throw new Error("paperclip request is not a credential-free API-relative path");
    parsed = { method, httpMethod: payload.httpMethod as "GET" | "POST" | "PATCH" | "PUT",
      path: payload.path, ...(payload.body === undefined ? {} : { body: payload.body }) };
  } else if (method === "paperclip.finish") {
    exact(payload, ["method", "status", "summary"], "payload");
    if (!["blocked", "in_review", "done"].includes(String(payload.status)) ||
      typeof payload.summary !== "string" || !payload.summary.trim() || payload.summary.length > 20_000)
      throw new Error("paperclip finish intent is invalid");
    parsed = { method, status: payload.status as "blocked" | "in_review" | "done", summary: payload.summary };
  } else throw new Error("restricted IPC method is not allowed");
  const result: PrimeRestrictedIpcRequest = {
    version: 2,
    authorityDigest: digest(input.authorityDigest, "authorityDigest"),
    operationId: identifier(input.operationId, "operationId"),
    requestId: identifier(input.requestId, "requestId"),
    payload: parsed,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > PRIME_MAX_FRAME_BYTES)
    throw new Error("restricted IPC frame is too large");
  return result;
}

export function parsePrimeRestrictedIpcResponse(
  value: unknown,
  requestId: string,
): PrimeRestrictedIpcResponse {
  const frame = record(value, "broker frame");
  if (
    frame.version !== 2 ||
    frame.requestId !== requestId ||
    !Number.isSafeInteger(frame.sequence) ||
    (frame.sequence as number) < 0
  )
    throw new Error("Paperclip broker receipt identity/sequence is invalid");
  if (frame.kind === "provider_event") {
    exact(frame, ["version", "requestId", "sequence", "kind", "event"], "broker frame");
    record(frame.event, "provider event");
    return frame as PrimeRestrictedIpcResponse;
  }
  if (frame.kind === "result") {
    exact(frame, ["version", "requestId", "sequence", "kind", "result"], "broker frame");
    const result = record(frame.result, "broker result");
    if (result.kind === "reservation") {
      exact(result, ["kind", "method", "state"], "reservation result");
      if (
        typeof result.method !== "string" ||
        !Object.hasOwn(BROKER_RESULT_BY_METHOD, result.method) ||
        !["dispatching", "uncertain"].includes(String(result.state))
      )
        throw new Error("Paperclip reservation observation is invalid");
    } else if (result.kind === "catalog") {
      exact(result, ["kind", "provider", "model", "available"], "catalog result");
      if (
        result.provider !== PRIME_RESTRICTED_PROVIDER ||
        typeof result.model !== "string" ||
        result.available !== true
      )
        throw new Error("Paperclip authenticated catalog is not the selected model");
    } else if (result.kind === "provider") {
      exact(result, ["kind", "providerRequestId", "state", "usage"], "provider result");
      if (result.providerRequestId !== null)
        identifier(result.providerRequestId, "provider request ID");
      if (
        !["accepted", "streaming", "completed", "aborted", "failed", "uncertain"].includes(
          String(result.state),
        ) ||
        (result.usage !== null && (typeof result.usage !== "object" || Array.isArray(result.usage)))
      )
        throw new Error("Paperclip provider receipt shape is invalid");
    } else if (result.kind === "mcp_tools") {
      exact(result, ["kind", "connectionId", "tools"], "MCP tools result");
      identifier(result.connectionId, "MCP connection");
      if (!Array.isArray(result.tools)) throw new Error("Paperclip MCP tool list is invalid");
    } else if (result.kind === "effect") {
      exact(
        result,
        [
          "kind",
          "requestId",
          "invocationId",
          "actionRequestId",
          "interactionId",
          "formalApprovalId",
          "argumentsHash",
          "state",
          "result",
        ],
        "effect result",
      );
      identifier(result.requestId, "effect original request ID");
      for (const key of ["invocationId", "actionRequestId", "interactionId", "formalApprovalId"]) {
        if (result[key] !== null) identifier(result[key], key);
      }
      digest(result.argumentsHash, "effect arguments hash");
      if (
        ![
          "reserved",
          "awaiting_approval",
          "executing",
          "completed",
          "failed",
          "uncertain",
        ].includes(String(result.state))
      )
        throw new Error("Paperclip governed effect state invalid");
    } else if (result.kind === "paperclip") {
      exact(result, ["kind", "requestId", "status", "body"], "Paperclip result");
      identifier(result.requestId, "Paperclip original request ID");
      if (!Number.isSafeInteger(result.status) || (result.status as number) < 200 ||
        (result.status as number) > 299)
        throw new Error("Paperclip governed request status is invalid");
    } else if (result.kind === "finalization") {
      exact(result, ["kind", "intentId", "issueId", "status", "summary", "state"], "finalization result");
      identifier(result.intentId, "finalization intent ID");
      identifier(result.issueId, "finalization issue ID");
      if (!["blocked", "in_review", "done"].includes(String(result.status)) ||
        typeof result.summary !== "string" || result.state !== "recorded")
        throw new Error("Paperclip finalization receipt invalid");
    } else if (result.kind === "operation") {
      exact(
        result,
        ["kind", "fenced", "provider", "governedActions", "outstandingEffects"],
        "operation result",
      );
      if (
        typeof result.fenced !== "boolean" ||
        !["settled", "uncertain"].includes(String(result.provider)) ||
        !["settled", "uncertain"].includes(String(result.governedActions)) ||
        !Number.isSafeInteger(result.outstandingEffects) ||
        (result.outstandingEffects as number) < 0
      )
        throw new Error("Paperclip operation settlement receipt invalid");
    } else throw new Error("Paperclip broker returned an unknown result kind");
    return frame as PrimeRestrictedIpcResponse;
  }
  if (frame.kind === "error") {
    exact(frame, ["version", "requestId", "sequence", "kind", "error"], "broker frame");
    const error = record(frame.error, "broker error");
    exact(error, ["code", "message"], "broker error");
    identifier(error.code, "broker error code");
    if (typeof error.message !== "string" || error.message.length > 4096)
      throw new Error("Paperclip broker error message invalid");
    return frame as PrimeRestrictedIpcResponse;
  }
  throw new Error("Paperclip broker frame kind is invalid");
}

/** Local reservation never permits duplicate external dispatch after response loss or BFF restart. */
export class PrimeRestrictedIpcDispatcher {
  private readonly inflight = new Map<
    string,
    { digest: string; promise: Promise<PrimeRestrictedIpcResponse[]> }
  >();
  private fenced = false;
  private controlCapabilityAvailable = false;
  private terminalProviderReceipt = false;
  private providerUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  } | null = null;
  private readonly accountedProviderRequests = new Set<string>();
  private recordedFinalization: {
    intentId: string; issueId: string; status: "blocked" | "in_review" | "done"; summary: string;
  } | null = null;
  constructor(
    private readonly authority: PrimeRestrictedIpcAuthority,
    private readonly handlers: PrimeRestrictedIpcHandlers,
    private readonly store: PrimeRestrictedIpcStore,
    private readonly now: () => number = () => Date.now(),
    private readonly observeFrame?: (
      request: PrimeRestrictedIpcRequest,
      frame: PrimeRestrictedIpcResponse,
    ) => void,
  ) {
    digest(authority.authorityDigest, "authorityDigest");
    if (
      authority.selection.provider !== PRIME_RESTRICTED_PROVIDER ||
      !authority.selection.model ||
      authority.selection.method !== "subscription"
    )
      throw new Error("restricted IPC authority route is invalid");
  }
  fenceExecution(): void {
    this.fenced = true;
  }
  enableControlCapability(): void {
    this.controlCapabilityAvailable = true;
  }
  get hasTerminalProviderReceipt(): boolean {
    return this.terminalProviderReceipt;
  }
  get usage(): { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null {
    return this.providerUsage;
  }
  get finalization(): {
    intentId: string; issueId: string; status: "blocked" | "in_review" | "done"; summary: string;
  } | null {
    return this.recordedFinalization;
  }
  get hasPendingRequests(): boolean {
    return this.inflight.size > 0;
  }

  async dispatch(
    value: unknown,
    onFrame?: (frame: PrimeRestrictedIpcResponse) => void | Promise<void>,
  ): Promise<PrimeRestrictedIpcResponse[]> {
    const request = parsePrimeRestrictedIpcRequest(value);
    if (
      request.authorityDigest !== this.authority.authorityDigest ||
      request.operationId !== this.authority.operationId
    )
      throw new Error("restricted IPC authority binding mismatch");
    const payload = request.payload;
    const readOnly = ["provider.status", "effect.status", "operation.status"].includes(payload.method);
    const requiresControl = ["provider.abort", "operation.stop"].includes(payload.method);
    const hasExecute = !this.fenced && Date.parse(this.authority.executeDeadlineAt) > this.now();
    const hasControl =
      this.controlCapabilityAvailable && Date.parse(this.authority.controlDeadlineAt) > this.now();
    if (
      ((requiresControl || readOnly) && !hasControl) ||
      (!requiresControl && !readOnly && !hasExecute)
    )
      throw new Error("restricted IPC purpose authority unavailable");
    if (this.fenced && !readOnly && !requiresControl)
      throw new Error("restricted IPC execution is fenced");
    if (payload.method === "provider.stream" && payload.turnId !== this.authority.turnId)
      throw new Error("provider turn binding mismatch");
    if (payload.method === "provider.stream" &&
      payload.request.model !== this.authority.selection.model)
      throw new Error("provider model differs from host-authorized model");
    if (payload.method === "provider.stream" && payload.request.tools !== undefined) {
      if (!Array.isArray(payload.request.tools))
        throw new Error("provider function declarations must be assigned tools");
      const pinned = [
        { name: "ipython", schemaSha256: this.authority.localTools[0].schemaSha256 },
        ...this.authority.mcp.tools
          .filter((tool) => tool.policy !== "deny")
          .map((tool) => ({
            name: `mcp_${createHash("sha256").update(`${tool.connectionId}\0${tool.name}`).digest("hex").slice(0, 32)}`,
            schemaSha256: tool.schemaSha256,
          })),
      ];
      const seen = new Set<string>();
      for (const raw of payload.request.tools) {
        const tool = record(raw, "provider function");
        const assigned = pinned.find((item) => item.name === tool.name);
        if (
          tool.type !== "function" ||
          typeof tool.name !== "string" ||
          seen.has(tool.name) ||
          !assigned ||
          tool.strict !== null ||
          primeCanonicalDigest(record(tool.parameters, "function parameters")) !==
            assigned.schemaSha256 ||
          Object.keys(tool).some(
            (key) => !["type", "name", "description", "parameters", "strict"].includes(key),
          )
        )
          throw new Error("provider function declaration differs from assigned schema");
        seen.add(tool.name);
      }
    }
    if (
      "targetRequestId" in payload &&
      (payload.targetRequestId === request.requestId ||
        !this.store.ownsRequest(request.operationId, payload.targetRequestId))
    )
      throw new Error("status/abort target is not an original request under this operation");
    if (payload.method === "mcp.tools.list" || payload.method === "mcp.tools.call") {
      const tools = this.authority.mcp.tools.filter(
        (tool) => tool.connectionId === payload.connectionId,
      );
      if (tools.length === 0) throw new Error("MCP connection is not assigned");
      if (
        payload.method === "mcp.tools.call" &&
        !tools.some((tool) => tool.name === payload.tool && tool.policy !== "deny")
      )
        throw new Error("MCP tool is not assigned by typed policy");
    }
    if (payload.method === "paperclip.finish" && this.recordedFinalization !== null &&
      !this.store.ownsRequest(request.operationId, request.requestId))
      throw new Error("Prime operation already recorded an immutable finalization intent");
    const requestDigest = createHash("sha256").update(canonical(request)).digest("hex");
    const inFlight = this.inflight.get(request.requestId);
    if (inFlight && inFlight.digest !== requestDigest)
      throw new Error("restricted IPC request ID reused with different arguments");
    if (inFlight) {
      const frames = await inFlight.promise;
      for (const frame of frames) await onFrame?.(frame);
      return frames;
    }
    const reservation = this.store.reserve(request.operationId, request.requestId, requestDigest);
    if (reservation.state !== "reserved") {
      for (const frame of reservation.response) await onFrame?.(frame);
      return reservation.response;
    }
    const promise = this.forward(
      request,
      requestDigest,
      requiresControl || readOnly ? "control" : "execute",
      onFrame,
    );
    this.inflight.set(request.requestId, { digest: requestDigest, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(request.requestId);
    }
  }

  private async forward(
    request: PrimeRestrictedIpcRequest,
    requestDigest: string,
    purpose: "execute" | "control",
    onFrame?: (frame: PrimeRestrictedIpcResponse) => void | Promise<void>,
  ): Promise<PrimeRestrictedIpcResponse[]> {
    const frames: PrimeRestrictedIpcResponse[] = [];
    const terminalResponses = new Map<string, "completed" | "failed">();
    let createdResponseId: string | null = null;
    let correlatedTerminal = false;
    let receivedBytes = 0;
    try {
      for await (const raw of this.handlers.broker(request, purpose)) {
        const previous = frames.at(-1);
        if (previous && ["result", "error"].includes(previous.kind))
          throw new Error("Paperclip broker emitted activity after its final receipt");
        const frame = parsePrimeRestrictedIpcResponse(raw, request.requestId);
        if (
          frame.kind === "provider_event" &&
          request.payload.method !== "provider.stream" &&
          request.payload.method !== "provider.status" &&
          request.payload.method !== "provider.abort"
        )
          throw new Error("Paperclip provider event escaped its reserved stream");
        if (
          frame.kind === "provider_event" &&
          request.payload.method !== "provider.stream" &&
          ![
            "response.completed",
            "response.failed",
            "response.incomplete",
            "response.done",
          ].includes(String(frame.event.type))
        )
          throw new Error("Paperclip status replay includes a non-terminal provider event");
        if (
          frame.kind === "result" &&
          frame.result.kind !== "reservation" &&
          frame.result.kind !== BROKER_RESULT_BY_METHOD[request.payload.method]
        )
          throw new Error("Paperclip broker result does not match the requested method");
        if (
          frame.kind === "result" &&
          frame.result.kind === "reservation" &&
          (frame.result.method !== request.payload.method || frames.length !== 0)
        )
          throw new Error("Paperclip reservation observation escaped its request");
        if (frame.kind === "result" && frame.result.kind === "catalog" &&
          frame.result.model !== this.authority.selection.model)
          throw new Error("authenticated catalog differs from selected model");
        if (frame.kind === "result" && frame.result.kind === "paperclip" &&
          frame.result.requestId !== request.requestId)
          throw new Error("Paperclip effect escaped original request");
        if (frame.kind === "result" && frame.result.kind === "finalization" &&
          (request.payload.method !== "paperclip.finish" ||
            frame.result.issueId !== this.authority.identity.issueId ||
            frame.result.status !== request.payload.status ||
            frame.result.summary !== request.payload.summary))
          throw new Error("Paperclip finalization differs from host-authorized own-issue intent");
        if (frame.kind === "result" && frame.result.kind === "mcp_tools") {
          const listed = frame.result.tools as Array<Record<string, unknown>>;
          const pinned = this.authority.mcp.tools.filter(
            (tool) => tool.connectionId === frame.result.connectionId,
          );
          if (
            frame.result.connectionId !==
              ("connectionId" in request.payload ? request.payload.connectionId : null) ||
            canonical([...listed].sort((a, b) => (String(a.name) < String(b.name) ? -1 : 1))) !==
              canonical([...pinned].sort((a, b) => (a.name < b.name ? -1 : 1)))
          )
            throw new Error(
              "Paperclip broker tool list differs from pinned assigned schema/policy",
            );
        }
        if (frame.kind === "result" && frame.result.kind === "effect") {
          const original =
            "targetRequestId" in request.payload
              ? request.payload.targetRequestId
              : request.requestId;
          if (frame.result.requestId !== original)
            throw new Error("Paperclip effect receipt escaped its original request");
        }
        if (previous && frame.sequence <= previous.sequence)
          throw new Error("Paperclip broker receipt sequence regressed");
        const frameBytes = Buffer.byteLength(JSON.stringify(frame));
        if (frameBytes > PRIME_MAX_FRAME_BYTES ||
          receivedBytes + frameBytes > PRIME_MAX_BROKER_RESPONSE_BYTES)
          throw new Error("Paperclip broker receipt byte budget exceeded");
        receivedBytes += frameBytes;
        frames.push(frame);
        if (frame.kind === "provider_event") {
          const response = frame.event.response;
          const identity =
            response && typeof response === "object" && !Array.isArray(response)
              ? (response as Record<string, unknown>)
              : null;
          if (frame.event.type === "response.created") {
            if (createdResponseId || typeof identity?.id !== "string" || !identity.id)
              throw new Error("Paperclip provider creation is uncorrelated");
            createdResponseId = identity.id;
          }
          if (
            [
              "response.completed",
              "response.failed",
              "response.incomplete",
              "response.done",
            ].includes(String(frame.event.type))
          ) {
            const completed =
              (frame.event.type === "response.completed" || frame.event.type === "response.done") &&
              identity?.status === "completed";
            const failed =
              (frame.event.type === "response.failed" && identity?.status === "failed") ||
              (frame.event.type === "response.incomplete" && identity?.status === "incomplete") ||
              (frame.event.type === "response.done" &&
                (identity?.status === "failed" || identity?.status === "incomplete"));
            if (
              typeof identity?.id !== "string" ||
              !identity.id ||
              (!completed && !failed) ||
              terminalResponses.size !== 0 ||
              (request.payload.method === "provider.stream" && identity.id !== createdResponseId)
            )
              throw new Error("Paperclip provider terminal is uncorrelated");
            terminalResponses.set(identity.id, completed ? "completed" : "failed");
          }
        }
        if (
          frame.kind === "result" &&
          frame.result.kind === "provider" &&
          ["completed", "failed"].includes(String(frame.result.state))
        ) {
          const id = frame.result.providerRequestId;
          // The host can definitively reject a request before provider acceptance.
          // Its original-owner status replay proves the same persisted no-SSE outcome.
          const nonacceptance = id === null && frame.result.state === "failed" &&
            frame.result.usage === null && frames.length === 1 &&
            createdResponseId === null && terminalResponses.size === 0 &&
            ["provider.stream", "provider.status", "provider.abort"].includes(request.payload.method);
          if (!nonacceptance &&
            (typeof id !== "string" || terminalResponses.get(id) !== frame.result.state))
            throw new Error("Paperclip provider result lacks matching terminal evidence");
          correlatedTerminal = true;
        }
        if (
          correlatedTerminal &&
          frame.kind === "result" &&
          frame.result.kind === "provider" &&
          frame.result.usage !== null &&
          typeof frame.result.usage === "object"
        ) {
          const originalRequestId =
            "targetRequestId" in request.payload
              ? request.payload.targetRequestId
              : request.requestId;
          const usage = frame.result.usage as Record<string, unknown>;
          const inputTokens = usage.input_tokens;
          const outputTokens = usage.output_tokens;
          const details = usage.input_tokens_details;
          const cachedInputTokens =
            details && typeof details === "object" && !Array.isArray(details)
              ? (details as Record<string, unknown>).cached_tokens
              : undefined;
          if (
            !this.accountedProviderRequests.has(originalRequestId) &&
            Number.isSafeInteger(inputTokens) &&
            Number.isSafeInteger(outputTokens) &&
            (inputTokens as number) >= 0 &&
            (outputTokens as number) >= 0
          ) {
            const totalInput = (this.providerUsage?.inputTokens ?? 0) + (inputTokens as number);
            const totalOutput = (this.providerUsage?.outputTokens ?? 0) + (outputTokens as number);
            const hasCached =
              Number.isSafeInteger(cachedInputTokens) && (cachedInputTokens as number) >= 0;
            const totalCached =
              (this.providerUsage?.cachedInputTokens ?? 0) +
              (hasCached ? (cachedInputTokens as number) : 0);
            if (
              !Number.isSafeInteger(totalInput) ||
              !Number.isSafeInteger(totalOutput) ||
              !Number.isSafeInteger(totalCached)
            )
              throw new Error("Paperclip provider usage exceeds exact numeric accounting");
            this.providerUsage = {
              inputTokens: totalInput,
              outputTokens: totalOutput,
              ...(hasCached || this.providerUsage?.cachedInputTokens !== undefined
                ? { cachedInputTokens: totalCached }
                : {}),
            };
            this.accountedProviderRequests.add(originalRequestId);
          }
        }
        this.observeFrame?.(request, frame);
        await onFrame?.(frame);
      }
      const finalFrame = frames.at(-1);
      if (!finalFrame || !["result", "error"].includes(finalFrame.kind))
        throw new Error("Paperclip broker stream ended without a result receipt");
      if (finalFrame.kind === "result" && finalFrame.result.kind === "reservation") {
        this.store.markUncertain(request.operationId, request.requestId, requestDigest, frames);
      } else {
        this.store.finalize(request.operationId, request.requestId, requestDigest, frames);
        if (correlatedTerminal) this.terminalProviderReceipt = true;
        if (finalFrame.kind === "result" && finalFrame.result.kind === "finalization") {
          const intent = finalFrame.result;
          this.recordedFinalization = {
            intentId: intent.intentId as string,
            issueId: intent.issueId as string,
            status: intent.status as "blocked" | "in_review" | "done",
            summary: intent.summary as string,
          };
        }
      }
      return frames;
    } catch {
      const uncertain: [PrimeRestrictedIpcResponse] = [
        {
          version: 2,
          requestId: request.requestId,
          sequence: (frames.at(-1)?.sequence ?? -1) + 1,
          kind: "error",
          error: {
            code: "broker_outcome_uncertain",
            message: "Paperclip broker outcome is uncertain",
          },
        },
      ];
      this.store.markUncertain(request.operationId, request.requestId, requestDigest, uncertain);
      try { await onFrame?.(uncertain[0]); }
      catch { /* The original recipient disconnected; uncertainty remains durably fenced. */ }
      return uncertain;
    }
  }
}
