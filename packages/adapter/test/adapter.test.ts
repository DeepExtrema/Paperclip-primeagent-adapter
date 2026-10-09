import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerAdapter, execute, sessionCodec } from "../src/index.js";
import {
  primeCanonicalDigest, parsePrimeRunEvent, sha256Text,
  type PrimeRunEvent, type PrimeRuntimeAuthority,
} from "../src/protocol.js";

const schema = { type: "object" };
const tool = {
  connectionId: "connection-1", name: "capture", description: "Save note",
  inputSchema: schema, schemaSha256: primeCanonicalDigest(schema), policy: "approval" as const,
};
const localSchema = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
const authority: PrimeRuntimeAuthority = {
  version: 2, operationId: "run-1", turnId: "run-1", prompt: "Handle assigned issue",
  identity: { companyId: "company-1", agentId: "agent-1", issueId: "issue-1",
    runId: "run-1", controllerId: "controller-1", responsibleUserId: "user-1" },
  workspace: { id: "workspace-1", executionWorkspaceId: "execution-1", root: "/workspace", realRoot: "/workspace" },
  instructions: { content: "Instructions", revision: null, sourcePath: "/managed/instructions.md",
    sha256: sha256Text("Instructions") },
  skills: [], mcp: { tools: [tool], gatewayId: "gateway-1", assignmentDigest: "a".repeat(64), setDigest: primeCanonicalDigest([tool]) },
  localTools: [{ name: "ipython", policy: "workspace-write", inputSchema: localSchema,
    schemaSha256: primeCanonicalDigest(localSchema) }],
  selection: { connectionId: "subscription-1", grantId: "grant-1", method: "subscription",
    provider: "openai-codex", model: "gpt-6.1-sol" },
  session: { namespace: "a".repeat(64), previous: null },
  harness: { maxSubagentDepth: 2, maxSubagents: 4 },
  generations: { controller: "1", issue: "1", run: "1", grant: "1", workspace: "1",
    instructions: "1", skills: "1", tools: "1" },
  executeDeadlineAt: "2030-01-01T12:00:00.000Z", controlDeadlineAt: "2030-01-02T12:00:00.000Z",
  containment: { profile: "paperclip-workspace-write-v3", disableDiscovery: true,
    protectManagedFiles: true, isolateCredentials: true, forbidAutonomousWork: true },
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Prime",
      adapterType: "prime_bff", adapterConfig: {} },
    runtime: { taskKey: "issue-1", sessionParams: null, sessionId: null, sessionDisplayId: null },
    config: { bffBaseUrl: "http://127.0.0.1:4173", model: authority.selection.model,
      env: { OPENAI_API_KEY: "never-forward" } },
    context: { paperclipWake: { prompt: "untrusted wake" } },
    primeRuntime: { executeCapability: "execute-only", controlCapability: "control-only",
      authorityDigest: primeCanonicalDigest(authority), authority, finalize: vi.fn(async () => undefined) },
    signal: new AbortController().signal,
    onCancellationReady: vi.fn(async () => undefined),
    onProviderStopped: vi.fn(async () => undefined),
    onLog: vi.fn(async () => undefined), onEvent: vi.fn(async () => undefined),
    onDispatch: vi.fn(), ...overrides,
  };
}

function completed(): PrimeRunEvent {
  return {
    type: "terminal", sequence: 2, receiptId: "receipt-2", turnId: "run-1",
    outcome: "completed", summary: "complete", errorCode: null,
    usage: { inputTokens: 19, outputTokens: 7, cachedInputTokens: 3 },
    session: { version: 3, companyId: "company-1", agentId: "agent-1", issueId: "issue-1",
      runId: "run-1", workspaceId: "workspace-1", executionWorkspaceId: "execution-1",
      workspaceRoot: "/workspace", namespace: authority.session.namespace,
      model: authority.selection.model, connectionId: authority.selection.connectionId,
      primeSessionId: "session-1", checkpoint: "c".repeat(64), checkpointDigest: "d".repeat(64),
      lastReceiptId: "receipt-2" },
    route: { provider: "openai-codex", model: authority.selection.model, billingType: "subscription" },
    finalization: null,
    settlement: { provider: "settled", worker: "stopped", descendants: "stopped",
      governedActions: "settled", evidence: ["upstream terminal receipt"] },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Prime external Paperclip adapter", () => {
  it("uses only immutable final authority and purpose-separated capabilities, preserving formal approval IDs", async () => {
    const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const events = [
        { type: "accepted", sequence: 0, receiptId: "receipt-0", turnId: "run-1",
          operationId: "run-1", primeSessionId: "session-1", resumed: false },
        { type: "approval_wait", sequence: 1, receiptId: "receipt-1", turnId: "run-1",
          effectId: "effect-1", invocationId: "invocation-1", actionRequestId: "action-1",
          interactionId: "interaction-1", formalApprovalId: "approval-1", issueId: "issue-1",
          tool: "capture", argumentsHash: "f".repeat(64) },
        completed(),
      ];
      return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    }));
    const ctx = context();
    const result = await execute(ctx);
    expect(result).toMatchObject({ exitCode: 0, usage: { inputTokens: 19, outputTokens: 7 },
      model: authority.selection.model, billingType: "subscription" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer execute-only");
    expect(sent[0]?.headers.get("x-paperclip-prime-control-capability")).toBe("control-only");
    expect(sent[0]?.body).toMatchObject({ prompt: authority.prompt,
      managedMcp: { tools: [{ name: "capture", policy: "approval" }] } });
    expect(JSON.stringify(sent[0]?.body)).not.toMatch(/never-forward|untrusted wake|apiKey|token|http:\/\//i);
    expect(ctx.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "approval_wait", payload: expect.objectContaining({
        invocationId: "invocation-1", actionRequestId: "action-1",
        interactionId: "interaction-1", formalApprovalId: "approval-1",
      }),
    }));
  });

  it("retains committed session params and calls trusted finalization only for settled success", async () => {
    const settled = completed();
    if (settled.type !== "terminal") throw new Error("invalid test terminal");
    const intent = { intentId: "intent-1", issueId: "issue-1", status: "in_review" as const,
      summary: "Ready for artifact review" };
    const finalized = { ...settled, finalization: intent };
    const fetchMock = vi.fn(async () => new Response([
      JSON.stringify({ type: "accepted", sequence: 0, receiptId: "receipt-0",
        turnId: "run-1", operationId: "run-1", primeSessionId: "session-1", resumed: false }),
      JSON.stringify(finalized),
    ].join("\n") + "\n"));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    const result = await execute(ctx);
    expect(result.sessionParams).toMatchObject(settled.session);
    expect(ctx.primeRuntime.finalize).toHaveBeenCalledWith({
      ...intent, operationId: "run-1", terminalReceiptId: "receipt-2",
    });
    expect(sessionCodec.serialize(result.sessionParams ?? null)).toMatchObject(settled.session);
  });

  it("rejects a scope-mismatched host checkpoint before dispatch", async () => {
    const original = completed();
    if (original.type !== "terminal") throw new Error("invalid test terminal");
    const mismatched = { ...original.session, namespace: "b".repeat(64) };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const next = context({
      runtime: { taskKey: "issue-1", sessionParams: mismatched },
      primeRuntime: {
        ...context().primeRuntime,
        authority: { ...authority, session: { namespace: authority.session.namespace,
          previous: { runId: "run-1", primeSessionId: "session-1", checkpoint: "c".repeat(64),
            checkpointDigest: "d".repeat(64), lastReceiptId: "receipt-2" } } },
      },
    });
    const result = await execute(next);
    expect(result).toMatchObject({ errorCode: "prime_bff_preflight_failed",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses invalid cross-wake sessions, unassigned model, or missing final capabilities before dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const input of [
      context({ runtime: { taskKey: "issue-1", sessionParams: { primeSessionId: "prior" } } }),
      context({ config: { bffBaseUrl: "http://127.0.0.1:4173", model: "paid-model" } }),
      context({ primeRuntime: { ...context().primeRuntime, controlCapability: "" } }),
    ]) {
      await expect(execute(input)).resolves.toMatchObject({ errorCode: "prime_bff_preflight_failed",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host without cancellation and dispatch lifecycle hooks", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const missing of ["signal", "onCancellationReady", "onProviderStopped", "onDispatch"])
      await expect(execute(context({ [missing]: undefined }))).resolves.toMatchObject({
        errorCode: "prime_bff_preflight_failed",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a lost dispatched response uncertain without asserting provider stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection closed"); }));
    await expect(execute(context())).resolves.toMatchObject({ exitCode: null,
      errorCode: "prime_run_uncertain", clearSession: false });
  });

  it.each(["truncated stream", "transport failure"] as const)(
    "preserves correlated owner stop settlement after %s",
    async (mode) => {
      const controller = new AbortController();
      const terminal = completed();
      if (terminal.type !== "terminal") throw new Error("invalid test terminal");
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "DELETE") return Response.json({
          operationId: "run-1", stopped: true, outcome: "stopped",
          settlement: terminal.settlement,
        });
        controller.abort();
        if (mode === "transport failure") throw new Error("connection closed");
        return new Response("");
      }));
      await expect(execute(context({ signal: controller.signal }))).resolves.toMatchObject({
        errorCode: "prime_run_cancelled",
        executionRecovery: { kind: "interrupted", providerStopped: true, actionOutcomes: "settled" },
        resultJson: { outcome: "cancelled", settlement: terminal.settlement },
      });
    },
  );

  it("does not release a writer on stopped:true without matching original-owner settlement", async () => {
    const controller = new AbortController();
    const terminal = completed();
    if (terminal.type !== "terminal") throw new Error("invalid test terminal");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") return Response.json({
        operationId: "different-run", stopped: true, outcome: "stopped",
        settlement: terminal.settlement,
      });
      controller.abort();
      return new Response("");
    }));
    const result = await execute(context({ signal: controller.signal }));
    expect(result).toMatchObject({ errorCode: "prime_run_uncertain", clearSession: false });
    expect(result.resultJson).toBeUndefined();
    expect(result.executionRecovery).toBeUndefined();
  });

  it("never converts approval progress into a successful terminal", () => {
    expect(() => parsePrimeRunEvent({ ...completed(), outcome: "awaiting_approval" }))
      .toThrow("event.outcome is invalid");
  });

  it("treats an absent host session as fresh and strips only known host metadata", () => {
    const original = completed();
    if (original.type !== "terminal") throw new Error("invalid test terminal");
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.deserialize({ __paperclipConfiguredModel: "gpt-6.1-sol" })).toBeNull();
    const stored = { ...original.session, paperclipAiCredentialIdentity: "host-only",
      __paperclipConfiguredModel: "gpt-6.1-sol",
      __paperclipConfigFingerprint: "host-only", __paperclipConfigFingerprintVersion: 1,
      __paperclipConfigCategories: [], __paperclipConfigCategoryFingerprints: {} };
    expect(sessionCodec.deserialize(stored)).toEqual(original.session);
    expect(() => sessionCodec.deserialize({ ...stored, namespace: "other" })).toThrow();
    expect(() => sessionCodec.deserialize({ ...stored, unexpected: "never stripped" })).toThrow();
  });

  it("reports host-assigned ephemeral skills without claiming durable installation", async () => {
    const snapshot = await createServerAdapter().listSkills({ config: {
      paperclipRuntimeSkills: [
        { key: "audit", name: "audit", source: "/managed/audit", sourceStatus: "available",
          versionId: "v2" },
        { key: "missing", name: "missing", source: "/managed/missing", sourceStatus: "missing",
          missingDetail: "source absent" },
      ],
    } });
    expect(snapshot).toMatchObject({
      supported: true, mode: "ephemeral", desiredSkills: ["audit", "missing"],
      entries: [{ state: "configured", desired: true }, { state: "missing", detail: "source absent" }],
    });
  });

  it("advertises no general agent JWT or native raw MCP delivery", () => {
    expect(createServerAdapter()).toMatchObject({
      supportsLocalAgentJwt: false, runtimeToolDelivery: "invocation_context",
      requiresMaterializedRuntimeSkills: true,
    });
  });
});
