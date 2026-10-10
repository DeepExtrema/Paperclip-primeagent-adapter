import { PRIME_BFF_PROTOCOL_VERSION, PRIME_CONTAINMENT_PROFILE, type PrimeRunEvent } from "@deepextrema/paperclip-primeagent-adapter"
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { PrimeRunBoundaryError, type PrimeRunSurface } from "./prime-run-port.js";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function bearer(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

function errorStatus(error: PrimeRunBoundaryError): 400 | 401 | 409 | 503 {
  switch (error.kind) {
    case "invalid":
      return 400;
    case "unauthorized":
      return 401;
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof PrimeRunBoundaryError) {
    return Response.json(
      { error: error.kind, message: error.message },
      { status: errorStatus(error) },
    );
  }
  return Response.json(
    { error: "unavailable", message: "Prime run boundary is unavailable" },
    { status: 503 },
  );
}

function streamEvents(events: AsyncIterable<PrimeRunEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Mounted outside `/api/*`; capability discovery is credential-free; run routes require signed Paperclip tokens. */
export function mountPrimeRunRoutes(app: Hono, surface: PrimeRunSurface): void {
  app.use(
    "/internal/paperclip/prime-runs",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "payload_too_large", message: "Prime run request is too large" }, 413),
    }),
  );
  app.get("/internal/paperclip/prime-runs/capabilities", (c) =>
    c.json({ protocolVersion: PRIME_BFF_PROTOCOL_VERSION, containmentProfile: PRIME_CONTAINMENT_PROFILE }));
  app.post("/internal/paperclip/prime-runs", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const controlBearerToken = c.req.header("x-paperclip-prime-control-capability");
    const headerRunId = c.req.header("x-paperclip-run-id")?.trim();
    if (token === null || !headerRunId || !controlBearerToken || /\s/.test(controlBearerToken)) {
      return c.json(
        { error: "unauthorized", message: "Signed Paperclip run identity required" },
        401,
      );
    }
    const contentType = c.req.header("content-type");
    if (contentType === undefined || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return c.json({ error: "unsupported_media_type", message: "Request body must be JSON" }, 415);
    }
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload_too_large", message: "Prime run request is too large" }, 413);
    }
    try {
      const request: unknown = await c.req.json();
      const events = await surface.start({ bearerToken: token, controlBearerToken, headerRunId, request });
      return new Response(streamEvents(events), {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.delete("/internal/paperclip/prime-runs/:operationId", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const headerRunId = c.req.header("x-paperclip-run-id")?.trim();
    if (token === null || !headerRunId) {
      return c.json(
        { error: "unauthorized", message: "Signed Paperclip run identity required" },
        401,
      );
    }
    try {
      const result = await surface.cancel({
        bearerToken: token,
        headerRunId,
        operationId: c.req.param("operationId"),
      });
      return c.json(
        { operationId: c.req.param("operationId"), stopped: result.outcome === "stopped", ...result },
        result.outcome === "uncertain" ? 503 : 200,
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/internal/paperclip/prime-runs/:operationId/events", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const headerRunId = c.req.header("x-paperclip-run-id")?.trim();
    if (token === null || !headerRunId)
      return c.json(
        { error: "unauthorized", message: "Signed Paperclip run identity required" },
        401,
      );
    const afterSequence = Number(c.req.query("afterSequence") ?? "-1");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1)
      return c.json({ error: "invalid", message: "afterSequence is invalid" }, 400);
    try {
      const events = await surface.observe({
        bearerToken: token,
        headerRunId,
        operationId: c.req.param("operationId"),
        afterSequence,
      });
      return c.json({ events }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.use("/internal/paperclip/prime-runs/:operationId/reconcile", bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "payload_too_large", message: "Prime recovery envelope is too large" }, 413),
  }));

  app.post("/internal/paperclip/prime-runs/:operationId/reconcile", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const headerRunId = c.req.header("x-paperclip-run-id")?.trim();
    if (token === null || !headerRunId)
      return c.json(
        { error: "unauthorized", message: "Signed Paperclip run identity required" },
        401,
      );
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
      return c.json({ error: "payload_too_large", message: "Prime recovery envelope is too large" }, 413);
    try {
      const text = await c.req.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES)
        return c.json({ error: "payload_too_large", message: "Prime recovery envelope is too large" }, 413);
      let recovery: { terminalReceiptId: string; request: unknown } | undefined;
      if (text.trim()) {
        if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
          return c.json({ error: "unsupported_media_type", message: "Recovery body must be JSON" }, 415);
        let body: unknown;
        try { body = JSON.parse(text); }
        catch { throw new PrimeRunBoundaryError("invalid", "Recovery body must be valid JSON"); }
        if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 2 || !Object.hasOwn(body, "terminalReceiptId") ||
          !Object.hasOwn(body, "request") ||
          typeof (body as Record<string, unknown>).terminalReceiptId !== "string" ||
          !(body as Record<string, unknown>).terminalReceiptId)
          throw new PrimeRunBoundaryError("invalid", "Original terminal and request envelope required");
        recovery = body as { terminalReceiptId: string; request: unknown };
      }
      const result = await surface.reconcile({
        bearerToken: token,
        headerRunId,
        operationId: c.req.param("operationId"),
        ...(recovery === undefined ? {} : { recovery }),
      });
      return c.json(
        { stopped: result.outcome === "stopped", ...result },
        result.outcome === "uncertain" ? 503 : 200,
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
}
