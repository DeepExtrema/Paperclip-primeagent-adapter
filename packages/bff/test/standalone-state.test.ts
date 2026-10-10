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
      .get("standalone-prime-v1")).toEqual({ version: 32 });
    expect(first.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prime_run_operations'")
      .get()).toEqual({ name: "prime_run_operations" });
    expect(first.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name = 'prime_run_reconciliations'`).get())
      .toEqual({ name: "prime_run_reconciliations" });
    expect(first.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name = 'prime_run_reconciliation_handoffs'`).get())
      .toEqual({ name: "prime_run_reconciliation_handoffs" });
    first.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare("SELECT version FROM prime_schema_version WHERE namespace = ?")
      .get("standalone-prime-v1")).toEqual({ version: 32 });
    reopened.close();
  });

  it("upgrades a retained v31 database without changing its original IPC receipts", () => {
    const path = join(freshRoot(), "prime-runs.sqlite");
    const existing = openDatabase(path);
    existing.exec(`INSERT INTO prime_run_operations
      (operation_id, company_id, agent_id, issue_id, run_id, turn_id, workspace_id,
       execution_workspace_id, workspace_root, request_digest, request_json, status,
       created_at, updated_at)
      VALUES ('prior', 'company', 'agent', 'issue', 'run', 'turn', 'workspace',
        'execution', '/prior', 'digest', NULL, 'uncertain', '2026-01-01', '2026-01-01');
      INSERT INTO prime_ipc_effects
      (operation_id, request_id, request_digest, state, response_json, created_at, updated_at)
      VALUES ('prior', 'original', 'original-digest', 'uncertain',
        '[{"kind":"error","message":"original"}]', '2026-01-01', '2026-01-01');
      DROP TABLE prime_run_reconciliation_handoffs;
      DROP TABLE prime_run_reconciliations;
      UPDATE prime_schema_version SET version = 31 WHERE namespace = 'standalone-prime-v1';`);
    const before = existing.prepare(`SELECT request_digest, state, response_json
      FROM prime_ipc_effects WHERE operation_id = 'prior'`).get();
    existing.close();
    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT version FROM prime_schema_version WHERE namespace = ?")
      .get("standalone-prime-v1")).toEqual({ version: 32 });
    expect(upgraded.prepare(`SELECT request_digest, state, response_json
      FROM prime_ipc_effects WHERE operation_id = 'prior'`).get()).toEqual(before);
    expect(upgraded.prepare("SELECT count(*) AS count FROM prime_run_reconciliations").get())
      .toEqual({ count: 0 });
    upgraded.close();
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
