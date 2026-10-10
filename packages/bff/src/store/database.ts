import { closeSync, lstatSync, openSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { PRIME_IPC_MIGRATION, PRIME_NATIVE_SESSION_MIGRATION, PRIME_RECONCILIATION_MIGRATION, PRIME_RUN_MIGRATION } from "./prime-run-migration.js";

export type { DatabaseType };

/** A private schema namespace; no Command Center or Paperclip app migrations run here. */
export function openDatabase(path: string): DatabaseType {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Standalone Prime database path must be absolute and normalized");
  for (const [name, create] of [[path, true], [`${path}-wal`, false], [`${path}-shm`, false]] as const) {
    try {
      const file = lstatSync(name);
      if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid()))
        throw new Error("Standalone Prime SQLite state and sidecars must be private regular files");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) {
        const fd = openSync(name, "wx", 0o600);
        closeSync(fd);
      }
    }
  }
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (db.pragma("foreign_keys", { simple: true }) !== 1 ||
      db.pragma("busy_timeout", { simple: true }) !== 5000 ||
      db.pragma("journal_mode = WAL", { simple: true }) !== "wal")
      throw new Error("Prime SQLite requires foreign keys, a 5-second busy timeout, and WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS prime_schema_version (
      namespace TEXT PRIMARY KEY CHECK (namespace = 'standalone-prime-v1'),
      version INTEGER NOT NULL
    )`);
    const migrations = [PRIME_RUN_MIGRATION, PRIME_IPC_MIGRATION, PRIME_NATIVE_SESSION_MIGRATION, PRIME_RECONCILIATION_MIGRATION];
    const apply = db.transaction(() => {
      const row = db.prepare("SELECT version FROM prime_schema_version WHERE namespace = ?")
        .get("standalone-prime-v1") as { version: number } | undefined;
      let version = row?.version ?? 0;
      if (version !== 0 && !migrations.some((migration) => migration.version === version))
        throw new Error(`Unsupported standalone Prime schema version ${version}`);
      for (const migration of migrations) {
        if (migration.version <= version) continue;
        db.exec(migration.sql);
        db.prepare(`INSERT INTO prime_schema_version (namespace, version) VALUES (?, ?)
          ON CONFLICT(namespace) DO UPDATE SET version = excluded.version`)
          .run("standalone-prime-v1", migration.version);
        version = migration.version;
      }
    });
    apply.immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
