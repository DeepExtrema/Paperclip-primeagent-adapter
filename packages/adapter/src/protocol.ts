import { createHash } from "node:crypto";
import { posix } from "node:path";

export const PRIME_BFF_ADAPTER_TYPE = "prime_bff";
export const PRIME_BFF_PROTOCOL_VERSION = 3;
export const PRIME_PROVIDER = "openai-codex";
export const PRIME_CONTAINMENT_PROFILE = "paperclip-workspace-write-v3";
export const PRIME_MAX_DEADLINE_MS = 60 * 60 * 1000;

const MAX_ID_CHARS = 160;
const MAX_PROMPT_CHARS = 1_000_000;
const MAX_LOG_CHARS = 256_000;
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL_OUTCOMES: Record<string, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  uncertain: true,
};

export interface PrimeRunIdentity {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
}

export interface PrimeRunSessionParams extends PrimeRunIdentity {
  version: 3;
  workspaceId: string;
  executionWorkspaceId: string;
  workspaceRoot: string;
  namespace: string;
  model: string;
  connectionId: string;
  primeSessionId: string;
  checkpoint: string | null;
  checkpointDigest: string | null;
  lastReceiptId: string;
}

export interface PrimeManagedMcpTool {
  connectionId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaSha256: string;
  policy: "allow" | "approval" | "deny";
}

/** Credential-free final realization persisted by Paperclip, never reconstructed from adapter config. */
export interface PrimeRuntimeAuthority {
  version: 2;
  operationId: string;
  turnId: string;
  prompt: string;
  identity: PrimeRunIdentity & { controllerId: string; responsibleUserId: string };
  workspace: { id: string; executionWorkspaceId: string; root: string; realRoot: string };
  instructions: { content: string; revision: string | null; sourcePath: string; sha256: string };
  skills: PrimeManagedSkill[];
  mcp: { setDigest: string; gatewayId: string | null; assignmentDigest: string | null; tools: PrimeManagedMcpTool[] };
  localTools: [{
    name: "ipython";
    policy: "workspace-write";
    inputSchema: Record<string, unknown>;
    schemaSha256: string;
  }];
  selection: {
    connectionId: string;
    grantId: string;
    method: "subscription";
    provider: "openai-codex";
    model: string;
  };
  session: { namespace: string; previous: null | {
    runId: string; primeSessionId: string; checkpoint: string; checkpointDigest: string; lastReceiptId: string;
  } };
  harness: { maxSubagentDepth: 2; maxSubagents: 4 };
  generations: {
    controller: string; issue: string; run: string; grant: string;
    workspace: string; instructions: string; skills: string; tools: string;
  };
  executeDeadlineAt: string;
  controlDeadlineAt: string;
  containment: {
    profile: "paperclip-workspace-write-v3";
    disableDiscovery: true; protectManagedFiles: true;
    isolateCredentials: true; forbidAutonomousWork: true;
  };
}
export interface PrimeManagedSkill {
  key: string;
  versionId: string | null;
  path: string;
  sha256: string;
}

export interface PrimeRunRequest {
  version: 3;
  authorityDigest: string;
  authority: PrimeRuntimeAuthority;
  operationId: string;
  turnId: string;
  identity: PrimeRunIdentity;
  workspace: {
    id: string;
    executionWorkspaceId: string;
    root: string;
    realRoot: string;
    mode: "workspace-write";
  };
  containment: PrimeRuntimeAuthority["containment"];
  model: {
    provider: "openai-codex";
    id: string;
    billingType: "subscription";
    allowFallback: false;
  };
  prompt: string;
  managedInstructions: PrimeRuntimeAuthority["instructions"];
  managedSkills: PrimeManagedSkill[];
  managedMcp: PrimeRuntimeAuthority["mcp"];
  previousSession: PrimeRunSessionParams | null;
  deadlineAt: string;
}

export interface PrimeSettlement {
  provider: "settled" | "uncertain";
  worker: "stopped" | "uncertain";
  descendants: "stopped" | "uncertain";
  governedActions: "settled" | "uncertain";
  evidence: string[];
}

interface ReceiptBase {
  sequence: number;
  receiptId: string;
  turnId: string;
}

export type PrimeRunEvent =
  | ({
      type: "accepted";
      operationId: string;
      primeSessionId: string;
      resumed: boolean;
    } & ReceiptBase)
  | ({ type: "message"; messageId: string; role: "assistant"; content: string } & ReceiptBase)
  | ({ type: "log"; messageId: string; stream: "stdout" | "stderr"; message: string } & ReceiptBase)
  | ({
      type: "tool_effect";
      effectId: string;
      toolCallId: string;
      toolName: string;
      phase: "requested" | "completed" | "failed";
      replaySafe: boolean;
    } & ReceiptBase)
  | ({ type: "checkpoint"; checkpoint: string } & ReceiptBase)
  | ({
      type: "approval_wait";
      effectId: string;
      invocationId: string;
      actionRequestId: string;
      interactionId: string | null;
      formalApprovalId: string | null;
      issueId: string;
      tool: string;
      argumentsHash: string;
    } & ReceiptBase)
  | ({
      type: "terminal";
      outcome: "completed" | "failed" | "cancelled" | "uncertain";
      summary: string | null;
      errorCode: string | null;
      usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
      session: PrimeRunSessionParams;
      route: { provider: "openai-codex"; model: string; billingType: "subscription" };
      finalization: { intentId: string; issueId: string; status: "blocked" | "in_review" | "done"; summary: string } | null;
      settlement: PrimeSettlement;
    } & ReceiptBase);

function rec(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string, max = MAX_ID_CHARS, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > max)
    throw new Error(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = str(value, label, 64);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function tokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function absolute(value: unknown, label: string): string {
  const result = str(value, label, 4096);
  if (
    result === "/" ||
    !result.startsWith("/") ||
    result.includes("\0") ||
    posix.normalize(result) !== result
  ) {
    throw new Error(`${label} must be a canonical non-root absolute path`);
  }
  return result;
}

function id(value: unknown, label: string): PrimeRunIdentity {
  const input = rec(value, label);
  return {
    companyId: str(input.companyId, `${label}.companyId`),
    agentId: str(input.agentId, `${label}.agentId`),
    issueId: str(input.issueId, `${label}.issueId`),
    runId: str(input.runId, `${label}.runId`),
  };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Matches Paperclip's primeDigest: recursively sorted JSON keys, ordered arrays. */
export function primeCanonicalDigest(value: unknown): string {
  return sha256Text(canonical(value));
}

export function parsePrimeRunSessionParams(value: unknown): PrimeRunSessionParams {
  const input = rec(value, "session");
  only(input, ["version", "companyId", "agentId", "issueId", "runId", "workspaceId",
    "executionWorkspaceId", "workspaceRoot", "namespace", "model", "connectionId",
    "primeSessionId", "checkpoint", "checkpointDigest", "lastReceiptId"], "session");
  if (input.version !== 3) throw new Error("session.version must be 3");
  return {
    version: 3,
    ...id(input, "session"),
    workspaceId: str(input.workspaceId, "session.workspaceId"),
    executionWorkspaceId: str(input.executionWorkspaceId, "session.executionWorkspaceId"),
    workspaceRoot: absolute(input.workspaceRoot, "session.workspaceRoot"),
    namespace: digest(input.namespace, "session.namespace"),
    model: str(input.model, "session.model", 256),
    connectionId: str(input.connectionId, "session.connectionId"),
    primeSessionId: str(input.primeSessionId, "session.primeSessionId"),
    checkpoint: input.checkpoint === null ? null : str(input.checkpoint, "session.checkpoint"),
    checkpointDigest: input.checkpointDigest === null ? null : digest(input.checkpointDigest, "session.checkpointDigest"),
    lastReceiptId: str(input.lastReceiptId, "session.lastReceiptId"),
  };
}

function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains an unexpected field`);
}

function parseAuthority(value: unknown): PrimeRuntimeAuthority {
  const a = rec(value, "authority");
  only(a, ["version", "operationId", "turnId", "identity", "workspace", "prompt", "instructions",
    "skills", "mcp", "localTools", "selection", "session", "harness", "generations",
    "executeDeadlineAt", "controlDeadlineAt", "containment"], "authority");
  if (a.version !== 2) throw new Error("authority version is not supported");
  const identity = rec(a.identity, "authority.identity");
  const workspace = rec(a.workspace, "authority.workspace");
  const instructions = rec(a.instructions, "authority.instructions");
  const mcp = rec(a.mcp, "authority.mcp");
  const selection = rec(a.selection, "authority.selection");
  const generations = rec(a.generations, "authority.generations");
  const session = rec(a.session, "authority.session");
  const harness = rec(a.harness, "authority.harness");
  const containment = rec(a.containment, "authority.containment");
  only(identity, ["companyId", "agentId", "issueId", "runId", "controllerId", "responsibleUserId"], "identity");
  only(workspace, ["id", "executionWorkspaceId", "root", "realRoot"], "workspace");
  only(instructions, ["content", "revision", "sourcePath", "sha256"], "instructions");
  only(mcp, ["setDigest", "gatewayId", "assignmentDigest", "tools"], "mcp");
  only(selection, ["connectionId", "grantId", "method", "provider", "model"], "selection");
  only(generations, ["controller", "issue", "run", "grant", "workspace", "instructions", "skills", "tools"], "generations");
  only(containment, ["profile", "disableDiscovery", "protectManagedFiles", "isolateCredentials", "forbidAutonomousWork"], "containment");
  only(session, ["namespace", "previous"], "authority.session");
  only(harness, ["maxSubagentDepth", "maxSubagents"], "authority.harness");
  if (containment.profile !== PRIME_CONTAINMENT_PROFILE ||
    containment.disableDiscovery !== true || containment.protectManagedFiles !== true ||
    containment.isolateCredentials !== true || containment.forbidAutonomousWork !== true ||
    selection.provider !== PRIME_PROVIDER || selection.method !== "subscription" ||
    harness.maxSubagentDepth !== 2 || harness.maxSubagents !== 4)
    throw new Error("authority route, harness or containment is not allowed");
  const model = str(selection.model, "selection.model", 256);
  const namespace = digest(session.namespace, "authority.session.namespace");
  const previous = session.previous === null ? null : rec(session.previous, "authority.session.previous");
  if (previous) {
    only(previous, ["runId", "primeSessionId", "checkpoint", "checkpointDigest", "lastReceiptId"],
      "authority.session.previous");
    str(previous.runId, "authority.session.previous.runId");
    str(previous.primeSessionId, "authority.session.previous.primeSessionId");
    str(previous.checkpoint, "authority.session.previous.checkpoint");
    digest(previous.checkpointDigest, "authority.session.previous.checkpointDigest");
    str(previous.lastReceiptId, "authority.session.previous.lastReceiptId");
  }
  const content = str(instructions.content, "authority.instructions.content", MAX_PROMPT_CHARS, true);
  const instructionsSha = digest(instructions.sha256, "authority.instructions.sha256");
  if (sha256Text(content) !== instructionsSha) throw new Error("authority instruction content changed");
  const root = absolute(workspace.root, "authority.workspace.root");
  const realRoot = absolute(workspace.realRoot, "authority.workspace.realRoot");
  if (root !== realRoot) throw new Error("authority workspace root is not canonical");
  if (!Array.isArray(a.skills) || !Array.isArray(mcp.tools)) throw new Error("authority assignments invalid");
  const skills = a.skills.map((value, index) => {
    const skill = rec(value, `authority.skills[${index}]`);
    only(skill, ["key", "versionId", "path", "sha256"], "skill");
    return {
      key: str(skill.key, "skill.key"),
      versionId: skill.versionId === null ? null : str(skill.versionId, "skill.versionId"),
      path: absolute(skill.path, "skill.path"),
      sha256: digest(skill.sha256, "skill.sha256"),
    };
  });
  const tools: PrimeManagedMcpTool[] = mcp.tools.map((value, index) => {
    const tool = rec(value, `authority.mcp.tools[${index}]`);
    only(tool, ["connectionId", "name", "description", "inputSchema", "schemaSha256", "policy"], "tool");
    if (!["allow", "approval", "deny"].includes(String(tool.policy)))
      throw new Error("authority tool policy invalid");
    const inputSchema = rec(tool.inputSchema, "tool.inputSchema");
    const schemaSha256 = digest(tool.schemaSha256, "tool.schemaSha256");
    if (primeCanonicalDigest(inputSchema) !== schemaSha256)
      throw new Error("authority tool schema changed");
    return {
      connectionId: str(tool.connectionId, "tool.connectionId"),
      name: str(tool.name, "tool.name"),
      description: str(tool.description, "tool.description", 8192, true),
      inputSchema, schemaSha256,
      policy: tool.policy as PrimeManagedMcpTool["policy"],
    };
  });
  if (primeCanonicalDigest(tools) !== digest(mcp.setDigest, "mcp.setDigest"))
    throw new Error("authority tool assignment changed");
  if (new Set(tools.map((tool) => `${tool.connectionId}\0${tool.name}`)).size !== tools.length)
    throw new Error("authority contains duplicate tools");
  const gatewayId = mcp.gatewayId === null ? null : str(mcp.gatewayId, "mcp.gatewayId");
  const assignmentDigest = mcp.assignmentDigest === null ? null : digest(mcp.assignmentDigest, "mcp.assignmentDigest");
  if ((gatewayId === null) !== (assignmentDigest === null) || gatewayId === null && tools.length > 0)
    throw new Error("authority governed gateway binding is invalid");
  if (!Array.isArray(a.localTools) || a.localTools.length !== 1)
    throw new Error("authority requires exactly one approved native local tool");
  const localTool = rec(a.localTools[0], "authority.localTools[0]");
  only(localTool, ["name", "policy", "inputSchema", "schemaSha256"], "local tool");
  if (localTool.name !== "ipython" || localTool.policy !== "workspace-write")
    throw new Error("native local tool is not authorized");
  const localSchema = rec(localTool.inputSchema, "local tool schema");
  const localDigest = digest(localTool.schemaSha256, "local tool schema digest");
  if (primeCanonicalDigest(localSchema) !== localDigest)
    throw new Error("authority local tool schema changed");
  const localTools: PrimeRuntimeAuthority["localTools"] = [{
    name: "ipython", policy: "workspace-write",
    inputSchema: localSchema, schemaSha256: localDigest,
  }];
  const executeDeadlineAt = str(a.executeDeadlineAt, "authority.executeDeadlineAt", 64);
  const controlDeadlineAt = str(a.controlDeadlineAt, "authority.controlDeadlineAt", 64);
  if (!Number.isFinite(Date.parse(executeDeadlineAt)) ||
    !Number.isFinite(Date.parse(controlDeadlineAt)) ||
    Date.parse(controlDeadlineAt) < Date.parse(executeDeadlineAt))
    throw new Error("authority deadline is invalid");
  const generation = (key: keyof PrimeRuntimeAuthority["generations"]) =>
    str(generations[key], `authority.generations.${key}`);
  return {
    version: 2, operationId: str(a.operationId, "authority.operationId"),
    turnId: str(a.turnId, "authority.turnId"),
    prompt: str(a.prompt, "authority.prompt", MAX_PROMPT_CHARS),
    identity: {
      ...id(identity, "authority.identity"),
      controllerId: str(identity.controllerId, "authority.identity.controllerId"),
      responsibleUserId: str(identity.responsibleUserId, "authority.identity.responsibleUserId"),
    },
    workspace: {
      id: str(workspace.id, "authority.workspace.id"),
      executionWorkspaceId: str(workspace.executionWorkspaceId, "authority.workspace.executionWorkspaceId"),
      root, realRoot,
    },
    instructions: {
      content, revision: instructions.revision === null ? null : str(instructions.revision, "instructions.revision"),
      sourcePath: absolute(instructions.sourcePath, "instructions.sourcePath"), sha256: instructionsSha,
    },
    skills, mcp: { setDigest: digest(mcp.setDigest, "mcp.setDigest"), gatewayId, assignmentDigest, tools },
    localTools,
    selection: {
      connectionId: str(selection.connectionId, "selection.connectionId"),
      grantId: str(selection.grantId, "selection.grantId"),
      method: "subscription", provider: PRIME_PROVIDER, model,
    },
    session: { namespace, previous: previous === null ? null : {
      runId: previous.runId as string, primeSessionId: previous.primeSessionId as string,
      checkpoint: previous.checkpoint as string, checkpointDigest: previous.checkpointDigest as string,
      lastReceiptId: previous.lastReceiptId as string,
    } },
    harness: { maxSubagentDepth: 2, maxSubagents: 4 },
    generations: {
      controller: generation("controller"), issue: generation("issue"),
      run: generation("run"), grant: generation("grant"),
      workspace: generation("workspace"), instructions: generation("instructions"),
      skills: generation("skills"), tools: generation("tools"),
    },
    executeDeadlineAt, controlDeadlineAt,
    containment: {
      profile: PRIME_CONTAINMENT_PROFILE,
      disableDiscovery: true, protectManagedFiles: true,
      isolateCredentials: true, forbidAutonomousWork: true,
    },
  };
}

export function parsePrimeRuntimeAuthority(value: unknown): PrimeRuntimeAuthority {
  return parseAuthority(value);
}

export function parsePrimeRunRequest(value: unknown): PrimeRunRequest {
  const input = rec(value, "request");
  only(input, ["version", "authorityDigest", "authority", "operationId", "turnId",
    "identity", "workspace", "containment", "model", "prompt", "managedInstructions",
    "managedSkills", "managedMcp", "previousSession", "deadlineAt"], "request");
  if (input.version !== 3) throw new Error("request.version must be 3");
  const authority = parseAuthority(input.authority);
  const identity = id(input.identity, "request.identity");
  const workspace = rec(input.workspace, "request.workspace");
  const containment = rec(input.containment, "request.containment");
  const model = rec(input.model, "request.model");
  if (workspace.mode !== "workspace-write" ||
    containment.profile !== PRIME_CONTAINMENT_PROFILE ||
    containment.disableDiscovery !== true || containment.protectManagedFiles !== true ||
    containment.isolateCredentials !== true || containment.forbidAutonomousWork !== true ||
    model.provider !== PRIME_PROVIDER || model.id !== authority.selection.model ||
    model.billingType !== "subscription" || model.allowFallback !== false)
    throw new Error("request route or containment is not allowed");
  const operationId = str(input.operationId, "request.operationId");
  const turnId = str(input.turnId, "request.turnId");
  const deadlineAt = str(input.deadlineAt, "request.deadlineAt", 64);
  if (operationId !== authority.operationId || turnId !== authority.turnId ||
    deadlineAt !== authority.executeDeadlineAt || input.prompt !== authority.prompt ||
    canonical(identity) !== canonical(id(authority.identity, "authority.identity")) ||
    workspace.id !== authority.workspace.id ||
    workspace.executionWorkspaceId !== authority.workspace.executionWorkspaceId ||
    workspace.root !== authority.workspace.root || workspace.realRoot !== authority.workspace.realRoot ||
    canonical(input.managedInstructions) !== canonical(authority.instructions) ||
    canonical(input.managedSkills) !== canonical(authority.skills) ||
    canonical(input.managedMcp) !== canonical(authority.mcp))
    throw new Error("launch request differs from stored final realization");
  const previousSession = input.previousSession === null ? null : parsePrimeRunSessionParams(input.previousSession);
  if ((previousSession === null) !== (authority.session.previous === null) ||
    previousSession !== null && (
      previousSession.checkpoint === null ||
      previousSession.checkpointDigest === null ||
      previousSession.namespace !== authority.session.namespace ||
      previousSession.model !== authority.selection.model ||
      previousSession.connectionId !== authority.selection.connectionId ||
      previousSession.companyId !== identity.companyId ||
      previousSession.agentId !== identity.agentId ||
      previousSession.issueId !== identity.issueId ||
      previousSession.workspaceId !== authority.workspace.id ||
      previousSession.executionWorkspaceId !== authority.workspace.executionWorkspaceId ||
      previousSession.workspaceRoot !== authority.workspace.realRoot ||
      canonical({
        runId: previousSession.runId, primeSessionId: previousSession.primeSessionId,
        checkpoint: previousSession.checkpoint, checkpointDigest: previousSession.checkpointDigest,
        lastReceiptId: previousSession.lastReceiptId,
      }) !== canonical(authority.session.previous)
    ))
    throw new Error("session is not the host-authorized committed checkpoint for this scope");
  return {
    version: 3,
    authorityDigest: digest(input.authorityDigest, "request.authorityDigest"),
    authority, operationId, turnId, identity,
    workspace: { ...authority.workspace, mode: "workspace-write" },
    containment: authority.containment,
    model: { provider: PRIME_PROVIDER, id: authority.selection.model, billingType: "subscription", allowFallback: false },
    prompt: str(input.prompt, "request.prompt", MAX_PROMPT_CHARS),
    managedInstructions: authority.instructions, managedSkills: authority.skills,
    managedMcp: authority.mcp,
    previousSession,
    deadlineAt,
  };
}

export function validatePrimeDeadline(request: PrimeRunRequest, now = Date.now()): void {
  const deadline = Date.parse(request.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > PRIME_MAX_DEADLINE_MS)
    throw new Error("request.deadlineAt must be in the future and no more than one hour away");
}

export function sessionMatchesRequest(
  session: PrimeRunSessionParams,
  request: PrimeRunRequest,
): boolean {
  return (
    session.companyId === request.identity.companyId &&
    session.agentId === request.identity.agentId &&
    session.issueId === request.identity.issueId &&
    session.workspaceId === request.workspace.id &&
    session.executionWorkspaceId === request.workspace.executionWorkspaceId &&
    session.workspaceRoot === request.workspace.realRoot &&
    session.namespace === request.authority.session.namespace &&
    session.model === request.model.id &&
    session.connectionId === request.authority.selection.connectionId
  );
}


export function settlementProvesRelease(settlement: PrimeSettlement): boolean {
  return (
    settlement.provider === "settled" &&
    settlement.worker === "stopped" &&
    settlement.descendants === "stopped" &&
    settlement.governedActions === "settled" &&
    settlement.evidence.length > 0
  );
}

export function parsePrimeRunEvent(value: unknown): PrimeRunEvent {
  const input = rec(value, "event");
  const base = {
    sequence: Number(input.sequence),
    receiptId: str(input.receiptId, "event.receiptId"),
    turnId: str(input.turnId, "event.turnId"),
  };
  if (!Number.isSafeInteger(base.sequence) || base.sequence < 0)
    throw new Error("event.sequence is invalid");
  if (input.type === "accepted")
    return {
      type: "accepted",
      ...base,
      operationId: str(input.operationId, "event.operationId"),
      primeSessionId: str(input.primeSessionId, "event.primeSessionId"),
      resumed: input.resumed === true,
    };
  if (input.type === "message")
    return {
      type: "message",
      ...base,
      messageId: str(input.messageId, "event.messageId"),
      role: "assistant",
      content: str(input.content, "event.content", MAX_PROMPT_CHARS, true),
    };
  if (input.type === "log")
    return {
      type: "log",
      ...base,
      messageId: str(input.messageId, "event.messageId"),
      stream: input.stream === "stderr" ? "stderr" : "stdout",
      message: str(input.message, "event.message", MAX_LOG_CHARS, true),
    };
  if (input.type === "checkpoint")
    return {
      type: "checkpoint",
      ...base,
      checkpoint: str(input.checkpoint, "event.checkpoint", 4096),
    };
  if (input.type === "tool_effect")
    return {
      type: "tool_effect",
      ...base,
      effectId: str(input.effectId, "event.effectId"),
      toolCallId: str(input.toolCallId, "event.toolCallId"),
      toolName: str(input.toolName, "event.toolName"),
      phase: input.phase === "completed" || input.phase === "failed" ? input.phase : "requested",
      replaySafe: input.replaySafe === true,
    };
  if (input.type === "approval_wait")
    return {
      type: "approval_wait",
      ...base,
      effectId: str(input.effectId, "event.effectId"),
      invocationId: str(input.invocationId, "event.invocationId"),
      actionRequestId: str(input.actionRequestId, "event.actionRequestId"),
      interactionId:
        input.interactionId === null
          ? null
          : str(input.interactionId, "event.interactionId"),
      formalApprovalId:
        input.formalApprovalId === null
          ? null
          : str(input.formalApprovalId, "event.formalApprovalId"),
      issueId: str(input.issueId, "event.issueId"),
      tool: str(input.tool, "event.tool"),
      argumentsHash: digest(input.argumentsHash, "event.argumentsHash"),
    };
  if (input.type === "terminal") {
    const settlement = rec(input.settlement, "event.settlement");
    const parsedSettlement: PrimeSettlement = {
      provider: settlement.provider === "settled" ? "settled" : "uncertain",
      worker: settlement.worker === "stopped" ? "stopped" : "uncertain",
      descendants: settlement.descendants === "stopped" ? "stopped" : "uncertain",
      governedActions: settlement.governedActions === "settled" ? "settled" : "uncertain",
      evidence: Array.isArray(settlement.evidence)
        ? settlement.evidence.map((v, i) => str(v, `event.settlement.evidence[${i}]`, 4096))
        : [],
    };
    const outcome = input.outcome;
    if (typeof outcome !== "string" ||
      !Object.hasOwn(TERMINAL_OUTCOMES, outcome))
      throw new Error("event.outcome is invalid");
    const session = parsePrimeRunSessionParams(input.session);
    const route = rec(input.route, "event.route");
    const model = str(route.model, "event.route.model", 256);
    if (route.provider !== PRIME_PROVIDER || route.billingType !== "subscription" ||
      model !== session.model)
      throw new Error("event.route is invalid");
    const usageInput = input.usage === null ? null : rec(input.usage, "event.usage");
    const usage =
      usageInput === null
        ? null
        : {
            inputTokens: tokenCount(usageInput.inputTokens, "event.usage.inputTokens"),
            outputTokens: tokenCount(usageInput.outputTokens, "event.usage.outputTokens"),
            ...(usageInput.cachedInputTokens === undefined
              ? {}
              : {
                  cachedInputTokens: tokenCount(
                    usageInput.cachedInputTokens,
                    "event.usage.cachedInputTokens",
                  ),
                }),
          };
    if (session.lastReceiptId !== base.receiptId)
      throw new Error("terminal session does not name its terminal receipt");
    if (outcome !== "uncertain" && !settlementProvesRelease(parsedSettlement))
      throw new Error("terminal outcome lacks complete settlement evidence");
    const finalization = input.finalization === null || input.finalization === undefined
      ? null : rec(input.finalization, "event.finalization");
    if (finalization && (
      outcome !== "completed" ||
      !["blocked", "in_review", "done"].includes(String(finalization.status)) ||
      typeof finalization.intentId !== "string" || !finalization.intentId ||
      typeof finalization.issueId !== "string" || !finalization.issueId ||
      typeof finalization.summary !== "string"))
      throw new Error("event.finalization is invalid");
    if (outcome === "completed" && (session.checkpoint === null || session.checkpointDigest === null))
      throw new Error("completed run has no committed native checkpoint");
    return {
      type: "terminal",
      ...base,
      outcome: outcome as Extract<PrimeRunEvent, { type: "terminal" }>["outcome"],
      summary:
        input.summary === null ? null : str(input.summary, "event.summary", MAX_LOG_CHARS, true),
      errorCode: input.errorCode === null ? null : str(input.errorCode, "event.errorCode"),
      usage,
      session,
      route: { provider: PRIME_PROVIDER, model, billingType: "subscription" },
      finalization: finalization === null ? null : {
        intentId: finalization.intentId as string, issueId: finalization.issueId as string,
        status: finalization.status as "blocked" | "in_review" | "done",
        summary: finalization.summary as string,
      },
      settlement: parsedSettlement,
    };
  }
  throw new Error("event.type is not supported");
}
