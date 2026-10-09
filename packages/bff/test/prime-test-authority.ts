import { type PrimeRunRequest,
type PrimeRuntimeAuthority,
primeCanonicalDigest,
sha256Text, } from "@deepextrema/paperclip-primeagent-adapter"

export const SCHEMA_DIGEST = primeCanonicalDigest({ type: "object" });
const LOCAL_SCHEMA = {
  type: "object", properties: { code: { type: "string" } }, required: ["code"],
};
const TOOL_ASSIGNMENTS = [
  { connectionId: "connection-1", name: "search", description: "search", inputSchema: { type: "object" }, schemaSha256: SCHEMA_DIGEST, policy: "allow" as const },
  { connectionId: "connection-1", name: "write", description: "write", inputSchema: { type: "object" }, schemaSha256: SCHEMA_DIGEST, policy: "approval" as const },
  { connectionId: "connection-1", name: "denied", description: "denied", inputSchema: { type: "object" }, schemaSha256: SCHEMA_DIGEST, policy: "deny" as const },
];

export function finalAuthority(overrides: Partial<PrimeRuntimeAuthority> = {}): PrimeRuntimeAuthority {
  const runId = overrides.identity?.runId ?? "run-1";
  return {
    version: 2,
    operationId: runId,
    turnId: `${runId}-turn`,
    prompt: "Complete assigned issue",
    identity: {
      companyId: "company-1", agentId: "agent-1", issueId: "issue-1", runId,
      controllerId: "controller-1", responsibleUserId: "user-1",
    },
    workspace: {
      id: "workspace-1", executionWorkspaceId: "execution-workspace-1",
      root: "/workspace", realRoot: "/workspace",
    },
    instructions: {
      content: "managed", revision: "revision-1", sourcePath: "/managed/instructions.md",
      sha256: sha256Text("managed"),
    },
    skills: [],
    mcp: { setDigest: primeCanonicalDigest(TOOL_ASSIGNMENTS), gatewayId: "gateway-1", assignmentDigest: "a".repeat(64), tools: TOOL_ASSIGNMENTS },
    localTools: [{ name: "ipython", policy: "workspace-write", inputSchema: LOCAL_SCHEMA,
      schemaSha256: primeCanonicalDigest(LOCAL_SCHEMA) }],
    selection: {
      connectionId: "connection", grantId: "grant", method: "subscription",
      provider: "openai-codex", model: "gpt-6.1-sol",
    },
    session: { namespace: "a".repeat(64), previous: null },
    harness: { maxSubagentDepth: 2, maxSubagents: 4 },
    generations: {
      controller: "1", issue: "1", run: "1", grant: "1", workspace: "1",
      instructions: "1", skills: "1", tools: "1",
    },
    executeDeadlineAt: "2030-01-01T12:00:00.000Z",
    controlDeadlineAt: "2030-01-02T12:00:00.000Z",
    containment: {
      profile: "paperclip-workspace-write-v3", disableDiscovery: true,
      protectManagedFiles: true, isolateCredentials: true, forbidAutonomousWork: true,
    },
    ...overrides,
  };
}

export const AUTHORITY_DIGEST = primeCanonicalDigest(finalAuthority());

export function launch(authority: PrimeRuntimeAuthority = finalAuthority()): PrimeRunRequest {
  return {
    version: 3, authorityDigest: primeCanonicalDigest(authority), authority,
    operationId: authority.operationId, turnId: authority.turnId,
    identity: {
      companyId: authority.identity.companyId, agentId: authority.identity.agentId,
      issueId: authority.identity.issueId, runId: authority.identity.runId,
    },
    workspace: { ...authority.workspace, mode: "workspace-write" },
    containment: { ...authority.containment },
    model: { provider: "openai-codex", id: authority.selection.model, billingType: "subscription", allowFallback: false },
    prompt: authority.prompt,
    managedInstructions: authority.instructions, managedSkills: authority.skills,
    managedMcp: authority.mcp, previousSession: null,
    deadlineAt: authority.executeDeadlineAt,
  };
}
