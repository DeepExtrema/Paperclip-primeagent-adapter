import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/database.js";
import { ownPrimeState } from "../src/state.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "prime-standalone-test-"));
  roots.push(root);
  return root;
}

describe("standalone Prime state isolation", () => {
  it("owns one process state root and persists the same private 32-byte control key across clean restarts", () => {
    const root = freshRoot();
    const first = ownPrimeState(root);
    expect(() => ownPrimeState(root)).toThrow();
    const secret = readFileSync(join(root, "control-secret.key"));
    expect(secret).toHaveLength(32);
    expect(first.secret).toEqual(secret);
    first.release();
    const second = ownPrimeState(root);
    expect(second.secret).toEqual(secret);
    second.release();
  });

  it("rejects a symlinked control key without leaving a newly acquired owner lock", () => {
    const root = freshRoot();
    const protectedPath = join(root, "prior-key");
    writeFileSync(protectedPath, Buffer.alloc(32), { mode: 0o600 });
    symlinkSync(protectedPath, join(root, "control-secret.key"));
    expect(() => ownPrimeState(root)).toThrow("private, regular");
    expect(readFileSync(protectedPath)).toHaveLength(32);
    expect(() => ownPrimeState(root)).toThrow("private, regular");
  });

  it("migrates only the dedicated Prime schema and preserves it on reopen", () => {
    const root = freshRoot();
    const path = join(root, "prime-runs.sqlite");
    const first = openDatabase(path);
    expect(first.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(first.prepare("SELECT version FROM prime_schema_version WHERE namespace = ?")
      .get("standalone-prime-v1")).toEqual({ version: 31 });
    expect(first.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prime_run_operations'")
      .get()).toEqual({ name: "prime_run_operations" });
    first.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare("SELECT version FROM prime_schema_version WHERE namespace = ?")
      .get("standalone-prime-v1")).toEqual({ version: 31 });
    reopened.close();
  });

  it("never follows a SQLite file or WAL symlink into another state store", () => {
    const root = freshRoot();
    const path = join(root, "prime-runs.sqlite");
    const protectedPath = join(root, "protected.sqlite");
    writeFileSync(protectedPath, "do-not-touch", { mode: 0o600 });
    symlinkSync(protectedPath, path);
    expect(() => openDatabase(path)).toThrow("private regular files");
    expect(readFileSync(protectedPath, "utf8")).toBe("do-not-touch");
    rmSync(path);
    symlinkSync(protectedPath, `${path}-wal`);
    expect(() => openDatabase(path)).toThrow("private regular files");
    expect(readFileSync(protectedPath, "utf8")).toBe("do-not-touch");
  });
});
