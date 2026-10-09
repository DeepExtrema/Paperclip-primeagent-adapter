import { realpath } from "node:fs/promises";
import { parsePrimeRuntimeAuthority,
primeCanonicalDigest,
type PrimeRunRequest,
type PrimeRuntimeAuthority, } from "@deepextrema/paperclip-primeagent-adapter"
import { attestedSkillDigest, attestedPathDigest } from "./bwrap-prime-worker.js";
import { PRIME_MAX_FRAME_BYTES } from "./prime-restricted-ipc.js";
import type { PaperclipRunIdentityVerifier, VerifiedPaperclipRun } from "./prime-run-port.js";
import { PrimeRunBoundaryError } from "./prime-run-port.js";

function loopbackApiBase(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash)
    throw new Error("Paperclip API URL must be credential-free loopback HTTP");
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api$/, "")}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid stored runtime authority");
  return value as Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}


export interface StoredPrimeAuthority {
  authority: PrimeRuntimeAuthority;
  authorityDigest: string;
  capabilityPurpose: "execute" | "control";
  projection: {
    fenced: boolean;
    provider: "settled" | "uncertain";
    governedActions: "settled" | "uncertain";
    outstandingEffects: number;
  };
}

/** BFF consumes Paperclip's persisted, purpose-capability-scoped final realization. */
export class PaperclipApiRunIdentityVerifier implements PaperclipRunIdentityVerifier {
  readonly apiBase: string;
  constructor(apiUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.apiBase = loopbackApiBase(apiUrl);
  }

  async stored(runId: string, bearerToken: string): Promise<StoredPrimeAuthority> {
    const response = await this.fetchImpl(
      `${this.apiBase}/api/heartbeat-runs/${encodeURIComponent(runId)}/runtime-authority`,
      { headers: { authorization: `Bearer ${bearerToken}`, "x-paperclip-run-id": runId } },
    );
    if (!response.ok) throw new PrimeRunBoundaryError("unauthorized", "Paperclip denied run authority");
    const body = record(await response.json());
    const authority = parsePrimeRuntimeAuthority(body.authority);
    const digest = body.authorityDigest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
      primeCanonicalDigest(authority) !== digest)
      throw new PrimeRunBoundaryError("unauthorized", "Paperclip authority digest is invalid");
    if (body.capabilityPurpose !== "execute" && body.capabilityPurpose !== "control")
      throw new PrimeRunBoundaryError("unauthorized", "Paperclip capability purpose is invalid");
    const projection = record(body.projection);
    if (typeof projection.fenced !== "boolean" ||
      !["settled", "uncertain"].includes(String(projection.provider)) ||
      !["settled", "uncertain"].includes(String(projection.governedActions)) ||
      !Number.isSafeInteger(projection.outstandingEffects) || (projection.outstandingEffects as number) < 0)
      throw new PrimeRunBoundaryError("unauthorized", "Paperclip settlement projection is invalid");
    return {
      authority, authorityDigest: digest, capabilityPurpose: body.capabilityPurpose,
      projection: projection as unknown as StoredPrimeAuthority["projection"],
    };
  }

  async verify(input: { bearerToken: string; runId: string; request: PrimeRunRequest }): Promise<VerifiedPaperclipRun> {
    const { request } = input;
    if (input.runId !== request.identity.runId) throw new PrimeRunBoundaryError("unauthorized", "run identity mismatch");
    const stored = await this.stored(input.runId, input.bearerToken);
    if (stored.capabilityPurpose !== "execute" || stored.projection.fenced ||
      Date.parse(stored.authority.executeDeadlineAt) <= Date.now() ||
      stored.authorityDigest !== request.authorityDigest ||
      canonical(stored.authority) !== canonical(request.authority))
      throw new PrimeRunBoundaryError("unauthorized", "launch differs from Paperclip's stored execution authority");
    try {
      if ((await realpath(request.workspace.realRoot)) !== request.workspace.realRoot ||
        (await realpath(request.managedInstructions.sourcePath)) !== request.managedInstructions.sourcePath ||
        (await attestedPathDigest(request.managedInstructions.sourcePath)) !== request.managedInstructions.sha256)
        throw new Error("workspace or instruction source changed");
      for (const skill of request.managedSkills) {
        if ((await attestedSkillDigest(skill.path)) !== skill.sha256) throw new Error("skill source changed");
      }
    } catch {
      throw new PrimeRunBoundaryError("unauthorized", "managed path provenance changed after realization");
    }
    const current = await this.stored(input.runId, input.bearerToken);
    if (current.capabilityPurpose !== "execute" || current.projection.fenced ||
      Date.parse(current.authority.executeDeadlineAt) <= Date.now() ||
      current.authorityDigest !== request.authorityDigest ||
      canonical(current.authority) !== canonical(request.authority))
      throw new PrimeRunBoundaryError("unauthorized", "launch authority changed during managed path verification");
    return {
      ...request.identity,
      verifiedAt: new Date().toISOString(),
      workspaceId: request.workspace.id,
      executionWorkspaceId: request.workspace.executionWorkspaceId,
      workspaceRoot: request.workspace.realRoot,
      authorityDigest: stored.authorityDigest,
      mcpConnectionIds: [...new Set(request.managedMcp.tools.map((tool) => tool.connectionId))].sort(),
    };
  }

  async verifyActor(input: {
    bearerToken: string;
    runId: string;
    operationId: string;
    expected?: { companyId: string; agentId: string; issueId: string; runId: string };
  }): Promise<PrimeRunRequest["identity"] & { operationId: string; authorityDigest: string; controlDeadlineAt: string }> {
    const stored = await this.stored(input.runId, input.bearerToken);
    const authority = stored.authority;
    const { expected } = input;
    if (stored.capabilityPurpose !== "control" || authority.operationId !== input.operationId ||
      authority.identity.runId !== input.runId || expected && (
        authority.identity.runId !== expected.runId ||
        authority.identity.companyId !== expected.companyId ||
        authority.identity.agentId !== expected.agentId ||
        authority.identity.issueId !== expected.issueId))
      throw new PrimeRunBoundaryError("unauthorized", "control capability is not bound to the original owner and purpose");
    return { ...authority.identity, operationId: authority.operationId,
      authorityDigest: stored.authorityDigest, controlDeadlineAt: authority.controlDeadlineAt };
  }

  /** Host-only constrained broker; never accepts a worker-selected origin or token. */
  async *broker(runId: string, bearerToken: string, request: unknown): AsyncIterable<unknown> {
    const response = await this.fetchImpl(
      `${this.apiBase}/api/heartbeat-runs/${encodeURIComponent(runId)}/prime-broker`,
      { method: "POST", headers: {
        authorization: `Bearer ${bearerToken}`, "x-paperclip-run-id": runId,
        "content-type": "application/json", accept: "application/x-ndjson",
      }, body: JSON.stringify(request) },
    );
    if (!response.ok || !response.body) throw new Error("Paperclip broker rejected this operation");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          if (Buffer.byteLength(line, "utf8") > PRIME_MAX_FRAME_BYTES)
            throw new Error("Paperclip broker frame exceeded the bounded buffer");
          buffered = buffered.slice(newline + 1);
          if (line) yield JSON.parse(line) as unknown;
          newline = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered, "utf8") > PRIME_MAX_FRAME_BYTES)
          throw new Error("Paperclip broker frame exceeded the bounded buffer");
      }
      if (buffered.trim()) throw new Error("Paperclip broker stream ended with a truncated frame");
    } finally { reader.releaseLock(); }
  }
}
