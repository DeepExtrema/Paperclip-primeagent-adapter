import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { primeCanonicalDigest, sha256Text, type PrimeRuntimeAuthority } from "@deepextrema/paperclip-primeagent-adapter"
import { PaperclipApiRunIdentityVerifier } from "../src/prime-runs/paperclip-run-verifier.js";
import { finalAuthority, launch } from "./prime-test-authority.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-stored-authority-"));
  roots.push(root);
  const instructionPath = join(root, "instructions.md");
  await writeFile(instructionPath, "managed", "utf8");
  const authority = finalAuthority({
    workspace: { id: "workspace-1", executionWorkspaceId: "execution-workspace-1", root, realRoot: root },
    instructions: { content: "managed", revision: "revision-1", sourcePath: instructionPath,
      sha256: sha256Text("managed") },
  });
  return { root, instructionPath, authority };
}

function verifier(authority: PrimeRuntimeAuthority,
  projection: { fenced: boolean; provider: "settled" | "uncertain"; governedActions: "settled" | "uncertain"; outstandingEffects: number } =
    { fenced: false, provider: "uncertain", governedActions: "uncertain", outstandingEffects: 0 },
  digest = primeCanonicalDigest(authority)) {
  const client = new PaperclipApiRunIdentityVerifier("http://127.0.0.1:3100", async (url, options) => {
    const target = String(url);
    const headers = new Headers(options?.headers);
    if (!target.endsWith(`/api/heartbeat-runs/${authority.identity.runId}/runtime-authority`) ||
      !["Bearer execute-capability", "Bearer control-capability"].includes(headers.get("authorization") ?? "") ||
      headers.get("x-paperclip-run-id") !== authority.identity.runId)
      return new Response(null, { status: 403 });
    return Response.json({ authority, authorityDigest: digest,
      capabilityPurpose: headers.get("authorization") === "Bearer control-capability" ? "control" : "execute", projection });
  });
  return { client };
}

describe("Paperclip persisted final authority", () => {
  it("rejects grant, generation, prompt, workspace and tool-policy tampering before launch", async () => {
    const { authority } = await fixture();
    const { client } = verifier(authority);
    const valid = launch(authority);
    await expect(client.verify({ bearerToken: "execute-capability", runId: "run-1", request: valid }))
      .resolves.toMatchObject({ authorityDigest: valid.authorityDigest, workspaceRoot: authority.workspace.realRoot });
    for (const forged of [
      { ...authority, selection: { ...authority.selection, grantId: "other-grant" } },
      { ...authority, generations: { ...authority.generations, grant: "2" } },
      { ...authority, prompt: "different task" },
      { ...authority, workspace: { ...authority.workspace, executionWorkspaceId: "other-workspace" } },
      { ...authority, mcp: { ...authority.mcp,
        tools: authority.mcp.tools.map((tool) => ({ ...tool, policy: "allow" as const })),
        setDigest: primeCanonicalDigest(authority.mcp.tools.map((tool) => ({ ...tool, policy: "allow" as const }))) } },
    ]) {
      await expect(client.verify({ bearerToken: "execute-capability", runId: "run-1",
        request: { ...valid, authority: forged } })).rejects.toMatchObject({ kind: "unauthorized" });
    }
  });

  it("uses immutable original-owner control even when live issue assignment changes", async () => {
    const { authority } = await fixture();
    const { client } = verifier(authority, {
      fenced: true, provider: "uncertain", governedActions: "uncertain", outstandingEffects: 1,
    });
    await expect(client.verifyActor({ bearerToken: "control-capability", runId: "run-1",
      operationId: "run-1", expected: {
        companyId: "company-1", agentId: "agent-1", issueId: "issue-1", runId: "run-1",
      } })).resolves.toMatchObject({ authorityDigest: primeCanonicalDigest(authority), operationId: "run-1" });
    await expect(client.verifyActor({ bearerToken: "control-capability", runId: "run-1",
      operationId: "other-operation", expected: {
        companyId: "company-1", agentId: "agent-1", issueId: "issue-1", runId: "run-1",
      } })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects changed instruction bytes after the stored realization", async () => {
    const { authority, instructionPath } = await fixture();
    const { client } = verifier(authority);
    await writeFile(instructionPath, "changed", "utf8");
    await expect(client.verify({ bearerToken: "execute-capability", runId: "run-1",
      request: launch(authority) })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("does not treat a fenced stored authority as fresh execute permission", async () => {
    const { authority } = await fixture();
    const { client } = verifier(authority, {
      fenced: true, provider: "uncertain", governedActions: "uncertain", outstandingEffects: 0,
    });
    await expect(client.verify({ bearerToken: "execute-capability", runId: "run-1",
      request: launch(authority) })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it.each(["execute", "control"] as const)("rejects %s capability use for the opposite purpose", async (purpose) => {
    const { authority } = await fixture();
    const { client } = verifier(authority);
    if (purpose === "execute")
      await expect(client.verifyActor({ bearerToken: "execute-capability", runId: authority.identity.runId,
        operationId: authority.operationId })).rejects.toMatchObject({ kind: "unauthorized" });
    else await expect(client.verify({ bearerToken: "control-capability", runId: authority.identity.runId,
      request: launch(authority) })).rejects.toMatchObject({ kind: "unauthorized" });
  });
  it("retains an authenticated broker frame larger than the former 1 MiB limit", async () => {
    const event = { version: 2, requestId: "provider-1", sequence: 0,
      kind: "provider_event", event: { type: "response.output_text.delta", delta: "x".repeat(1_050_000) } };
    const client = new PaperclipApiRunIdentityVerifier("http://127.0.0.1:3100",
      async () => new Response(`${JSON.stringify(event)}\n`));
    const received: unknown[] = [];
    for await (const receipt of client.broker("run-1", "execute-capability", {}))
      received.push(receipt);
    expect(received).toEqual([event]);
  });
});
