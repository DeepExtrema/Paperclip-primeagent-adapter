import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PrimeRunSurface } from "../src/prime-runs/prime-run-port.js";
import { mountPrimeRunRoutes } from "../src/prime-runs/prime-run-routes.js";
import { finalAuthority, launch } from "./prime-test-authority.js";

function surface(): PrimeRunSurface {
  return {
    start: vi.fn(async (input) => {
      async function* events() {
        yield {
          type: "accepted" as const,
          sequence: 0,
          receiptId: "receipt-0",
          turnId: "turn-1",
          operationId: input.headerRunId,
          primeSessionId: "prime-session-1",
          resumed: false,
        };
        yield {
          type: "terminal" as const,
          sequence: 1,
          receiptId: "receipt-1",
          turnId: "turn-1",
          outcome: "completed" as const,
          summary: "hello",
          errorCode: null,
          usage: { inputTokens: 1, outputTokens: 1 },
          session: {
            version: 3 as const,
            companyId: "company-1",
            agentId: "agent-1",
            issueId: "issue-1",
            runId: input.headerRunId,
            workspaceId: "workspace-1",
            executionWorkspaceId: "execution-workspace-1",
            workspaceRoot: "/workspace",
            namespace: "a".repeat(64),
            model: "gpt-6.1-sol",
            connectionId: "connection",
            primeSessionId: "prime-session-1",
            checkpoint: "c".repeat(64),
            checkpointDigest: "d".repeat(64),
            lastReceiptId: "receipt-1",
          },
          route: {
            provider: "openai-codex" as const,
            model: "gpt-6.1-sol" as const,
            billingType: "subscription" as const,
          },
          finalization: null,
          settlement: {
            provider: "settled" as const,
            worker: "stopped" as const,
            descendants: "stopped" as const,
            governedActions: "settled" as const,
            evidence: ["test"],
          },
        };
      }
      return events();
    }),
    cancel: vi.fn(async () => ({ outcome: "stopped" as const, settlement: {
      provider: "settled" as const, worker: "stopped" as const,
      descendants: "stopped" as const, governedActions: "settled" as const,
      evidence: ["original-owner stop receipt"],
    } })),
    observe: vi.fn(async () => []),
    reconcile: vi.fn(async () => "stopped" as const),
  };
}

describe("Prime run routes", () => {
  it("requires a signed run identity before reading a launch body", async () => {
    const app = new Hono();
    const runs = surface();
    mountPrimeRunRoutes(app, runs);
    const response = await app.request("/internal/paperclip/prime-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(runs.start).not.toHaveBeenCalled();
  });

  it("advertises only the mounted v3 containment capability without run secrets", async () => {
    const app = new Hono();
    mountPrimeRunRoutes(app, surface());
    const response = await app.request("/internal/paperclip/prime-runs/capabilities");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 3, containmentProfile: "paperclip-workspace-write-v3",
    });
  });

  it("admits a legitimate million-character managed prompt instead of the former 2 MiB cap", async () => {
    const app = new Hono();
    const runs = surface();
    mountPrimeRunRoutes(app, runs);
    const authority = finalAuthority({ prompt: "a".repeat(1_050_000) });
    const response = await app.request("/internal/paperclip/prime-runs", {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-signed-token",
        "x-paperclip-prime-control-capability": "original-owner-control",
        "content-type": "application/json",
        "x-paperclip-run-id": "run-1",
      },
      body: JSON.stringify(launch(authority)),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(runs.start).toHaveBeenCalledOnce();
  });

  it("returns lossless NDJSON receipts and targets cancellation by run id", async () => {
    const app = new Hono();
    const runs = surface();
    mountPrimeRunRoutes(app, runs);
    const headers = {
      authorization: "Bearer opaque-signed-token",
      "x-paperclip-prime-control-capability": "original-owner-control",
      "content-type": "application/json",
      "x-paperclip-run-id": "run-1",
    };
    const response = await app.request("/internal/paperclip/prime-runs", {
      method: "POST",
      headers,
      body: JSON.stringify(launch()),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual(["accepted", "terminal"]);
    expect(runs.start).toHaveBeenCalledWith({
      bearerToken: "opaque-signed-token",
      controlBearerToken: "original-owner-control",
      headerRunId: "run-1",
      request: launch(),
    });

    const cancelled = await app.request("/internal/paperclip/prime-runs/run-1", {
      method: "DELETE",
      headers,
    });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toEqual({
      operationId: "run-1", stopped: true, outcome: "stopped",
      settlement: { provider: "settled", worker: "stopped", descendants: "stopped",
        governedActions: "settled", evidence: ["original-owner stop receipt"] },
    });
  });
});
