export const PRIME_RUN_MIGRATION = {
  version: 29,
  sql: `
    CREATE TABLE prime_run_operations (
      operation_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      execution_workspace_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      prime_session_id TEXT,
      checkpoint TEXT,
      request_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'admitted', 'running', 'awaiting_approval', 'completed', 'failed',
        'cancelled', 'uncertain'
      )),
      terminal_json TEXT CHECK (terminal_json IS NULL OR json_valid(terminal_json)),
      last_sequence INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE prime_run_receipts (
      operation_id TEXT NOT NULL REFERENCES prime_run_operations(operation_id),
      sequence INTEGER NOT NULL,
      receipt_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, sequence)
    );

    CREATE TABLE prime_writer_leases (
      workspace_root TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      writer_kind TEXT NOT NULL CHECK (writer_kind IN ('paperclip_prime', 'browser_daemon')),
      company_id TEXT,
      agent_id TEXT,
      issue_id TEXT,
      run_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'stopping', 'uncertain')),
      acquired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX prime_run_operations_identity
      ON prime_run_operations (company_id, agent_id, issue_id, run_id);
    CREATE INDEX prime_run_receipts_replay
      ON prime_run_receipts (operation_id, sequence);
    CREATE UNIQUE INDEX prime_writer_leases_agent
      ON prime_writer_leases (company_id, agent_id) WHERE writer_kind = 'paperclip_prime';
  `,
} as const;

export const PRIME_IPC_MIGRATION = {
  version: 30,
  sql: `
    CREATE TABLE prime_ipc_effects (
      operation_id TEXT NOT NULL REFERENCES prime_run_operations(operation_id),
      request_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'final', 'uncertain')),
      response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, request_id)
    );
  `,
} as const;

export const PRIME_NATIVE_SESSION_MIGRATION = {
  version: 31,
  sql: `
    ALTER TABLE prime_run_operations ADD COLUMN request_json TEXT
      CHECK (request_json IS NULL OR json_valid(request_json));
    CREATE INDEX prime_writer_leases_issue
      ON prime_writer_leases (company_id, issue_id) WHERE writer_kind = 'paperclip_prime';
  `,
} as const;
