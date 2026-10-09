import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrimeControlStore } from "../src/prime-runs/prime-control-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepared() {
  const root = await mkdtemp(join(tmpdir(), "prime-control-restart-"));
  roots.push(root);
  const store = new PrimeControlStore(join(root, "control"), "host-private-secret");
  const entry = { purpose: "control" as const, operationId: "operation-1", runId: "run-1", authorityDigest: "a".repeat(64),
    controlDeadlineAt: "2030-01-02T12:00:00.000Z", capability: "original-owner-control-secret" };
  store.save(entry);
  return { root, entry, store };
}

describe("encrypted original-owner control persistence", () => {
  it("recovers only the same operation capability after process restart, never plaintext", async () => {
    const { root, entry } = await prepared();
    const reopened = new PrimeControlStore(join(root, "control"), "host-private-secret");
    expect(reopened.read("operation-1")).toEqual(entry);
    expect(reopened.read("other-operation")).toBeNull();
    const files = await readdir(join(root, "control"));
    const bytes = await readFile(join(root, "control", files[0]!));
    expect(bytes.toString("utf8")).not.toContain(entry.capability);
    expect(bytes.toString("utf8")).not.toContain("host-private-secret");
  });

  it("keeps uncertainty on rotated key, changed owner, and tampered authenticated binding", async () => {
    const { root, entry, store } = await prepared();
    const directory = join(root, "control");
    expect(() => new PrimeControlStore(directory, "rotated-host-secret").read(entry.operationId)).toThrow();
    expect(() => store.save({ ...entry, capability: "widened-control" })).toThrow();
    const files = await readdir(directory);
    const path = join(directory, files[0]!);
    const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...envelope, runId: "other-run" }), "utf8");
    expect(() => store.read(entry.operationId)).toThrow();
  });

  it("retains an authenticated stop intent across reopen and refuses a different operation binding", async () => {
    const { root, entry, store } = await prepared();
    expect(store.isStopping(entry.operationId)).toBe(false);
    store.markStopping(entry.operationId);
    const reopened = new PrimeControlStore(join(root, "control"), "host-private-secret");
    expect(reopened.isStopping(entry.operationId)).toBe(true);
    expect(reopened.read(entry.operationId)).toEqual(entry);
    const directory = join(root, "control");
    const files = await readdir(directory);
    const marker = files.find((file) => file.endsWith(".stopping"))!;
    const value = JSON.parse(await readFile(join(directory, marker), "utf8"));
    value[0] = "other-operation";
    await writeFile(join(directory, marker), JSON.stringify(value), { mode: 0o600 });
    expect(() => reopened.isStopping(entry.operationId)).toThrow();
  });

  it("rejects execute-purpose control persistence and unclassified legacy envelopes", async () => {
    const { root, entry, store } = await prepared();
    expect(() => store.save({ ...entry, purpose: "execute" as "control" })).toThrow();
    const directory = join(root, "control");
    const [file] = await readdir(directory);
    const path = join(directory, file!);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...envelope, version: 1 }), { mode: 0o600 });
    expect(() => store.read(entry.operationId)).toThrow();
  });
});
