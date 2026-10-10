# Architecture and continuity

## Boundaries

```text
Paperclip host (PostgreSQL, subscription and issue authority)
  ├── final immutable run realization: identity, model, workspace, instructions,
  │   skills, tool assignment, purpose-specific execute/control capabilities
  ├── provider refresh + authenticated catalog + governed MCP/status effects
  └── external prime_bff adapter ──loopback HTTP──> standalone BFF
                                          │        owner-only SQLite/WAL, event journal,
                                          │        settled immutable checkpoints
                                          └── restricted Unix IPC ──> bwrap worker
                                              no network/ambient credentials
                                              actual patched Prime Agent ACP binary
                                              + prebuilt native Python kernel
```

A patched Paperclip host at the exact pin is required: a stock external-adapter contract cannot supply final Prime authority, separate execute/control stop capabilities, broker routes, physical writer locks or the migration. The adapter validates that authority and speaks BFF **protocol v3**; the BFF independently verifies run identity against the host, pins the native binary and entire runtime by SHA-256, reserves a physical writer for the workspace and journals receipts. The broker, not the agent, authenticates against the selected subscription and invokes Paperclip's assigned tools. The worker's Unix IPC speaks a restricted request vocabulary with request identities/receipts, not arbitrary host API or a general network proxy.

The BFF's state directory is distinct from the host PostgreSQL and project workspace. It has its own schema namespace (`standalone-prime-v1`), SQLite WAL sidecars, control secret, owner lock, receipts and immutable native checkpoints. The host retains its own authority, broker requests/receipts and physical writer records. Both sides must agree on identity and actual correlated settlement; a BFF process exit or an HTTP response alone cannot release host writer exclusion.

## Actual native execution

The BFF launches `prime-agent --mode acp --managed-manifest /run/prime/manifest.json` under `/usr/bin/bwrap`, with a read-only pinned native runtime at `/opt/paperclip/runtime` and a prebuilt Python at `/opt/paperclip/runtime/kernel-env/bin/python`. It starts with an empty environment, private `/home/prime` and `/tmp`, an isolated network namespace, only the assigned writable workspace, assigned read-only skill/resource mounts, and a restricted IPC socket. Managed native patches disable installer fallback, ambient extensions/discovery and privileged outer Git capture; project code/Git execution occurs inside the contained Python kernel. The harness keeps root, child and compaction route locked to the host's exact selected subscription model; max child depth 2 and max children created 4. These are source contracts; source checks alone do not establish a successful live provider or child-run qualification.

Controlled-broker runs executed this compiled Prime 0.9.7/Python stack, not a simulated native harness: depth-3 and fifth-child attempts were rejected under the depth-2/four-child bounds, accepted descendants settled, and explicit compaction wrote a native journal entry. A threshold compaction used a real 2.3 MiB input but fixture-reported 785,005 of 800,000 tokens; it establishes the threshold path, **not** a measured subscription token bill. None of these observations establishes an authenticated live provider turn.

The supplied patches are part of the product, not optional enhancements: `paperclip.patch` adds host authority/broker/physical exclusion and migration `0294`; `prime-agent.patch` adds the managed native transport, checkpoint strictness and containment-facing behavior; `prime-catalog.patch` updates native catalog metadata, including `openai-codex/gpt-6.1-sol`. [`sources.json`](../upstream/sources.json) pins all three. Source cloning/patch application establishes provenance only; the host checks the *live authenticated subscription model catalog* at run admission.

Host and native catalog discovery advertise Codex client version `0.162.0`. The upstream endpoint filters models by client version: an old version may return HTTP 200 with an incomplete catalog. Keep that version aligned with the pinned model metadata; never treat a missing exact model as permission to substitute another model or bypass authenticated admission.

Foreground response admission follows native Codex: a successful HTTP response must have a body, but its Content-Type label is not settlement evidence or an additional MIME gate. The broker parses bounded SSE and requires a matching `response.created` identity and terminal event. HTTP 200 with a non-SSE body, malformed stream, missing terminal or mismatched identity remains uncertain. Fixed-category diagnostics identify credential, authorization, transport, header, parsing and receipt stages without logging upstream bodies or arbitrary errors.

## Checkpoints and scope

Distinguish four kinds of state:

1. **Workspace files:** durable project data in the preprovisioned root, independently backed up by the operator; not a conversation snapshot and not a license to share writers.
2. **In-flight Python objects:** live within a running kernel only. A new worker does **not** restore arbitrary Python RAM or re-execute old cells.
3. **Native continuity:** Prime's persisted session transcript plus the kernel/harness state artifacts the patched native code explicitly saves. The BFF seals an immutable private checkpoint **only after a completed settled terminal**, hashes its tree, binds it to the original terminal receipt and stores the checkpoint ID/digest in host session parameters.
4. **Execution authority:** the host/BFF journals, selected connection, effects, settlement and physical writer exclusion. A copied transcript alone is not execution authority.

A continuation requires the same company, agent, issue, execution workspace, canonical root, session namespace, connection, model and earlier completed/settled BFF receipt. The BFF verifies stored checkpoint metadata and content digest before staging a private per-run writable copy. The native session loader rejects missing, torn or mismatched sessions; there is **no** permissive repair, automatic reset, rotation or speculative cell replay. An uncertain/interrupted run must not turn into a clean new session simply because the previous worker disappeared.

## Effects, accounting and issue disposition

All provider streams are brokered under the host-selected `openai-codex` subscription grant; credential refresh stays in the host. The BFF/native transport records correlated provider and governed-effect identities. Assigned MCP calls have stable invocation/effect identities and policy checks, including an approval wait and the actual executed, failed or rejected outcome; approval is not a signal to issue a second call. The native `finish` request records an *intent* for `blocked`, `in_review` or `done` on the assigned issue. Paperclip applies issue status only after the matching settled terminal receipt and its existing actor/artifact gates. If commit/receipt is ambiguous, it stays uncertain rather than reapplying it optimistically.

Native children may have independently identified provider requests in flight at the same time. The host permits overlap only while each prior dispatch remains actively owned in its `dispatching` or `streaming` state. Orphaned or uncertain effects and unresolved approval/execution states still fence new execution. Duplicate request IDs replay their existing receipts, not the external operation.

Credential ownership has a separate lifetime from provider outcome. Prime's subscription never leaves the host. Closing its host registration immediately refuses new credential admission, aborts its catalog/stream HTTP scopes and waits for every admitted scope to unwind. An already-admitted OAuth refresh retains its independent controller and must finish committing or leave durable recovery evidence; teardown cannot cancel that obligation or issue a post-close catalog request. Only then may normal managed-account cleanup run, and a remaining refresh fence still prevents release. No provider, governed-effect, worker or physical-writer settlement is inferred from this drain. CLI/native runtimes that receive credential files keep their existing detached-owner retention rule.

In controlled-native tests the MCP allow path and both approval-to-completed and approval-to-failed/rejected paths followed the **original** effect's status; rejection caused no side effect or redispatch. A cancelled but uncertain MCP invocation retained the workspace writer and blocked another admission. These tested transitions do not prove live gateway/approval settlement in another deployment; the host and BFF must correlate actual original receipts there.

Reported usage is per **run** (root and native children counted once), with `provider=openai-codex`, biller `chatgpt` and `billingType=subscription`. `costUsd` is **null**: token counts/allowance are not a fabricated pay-as-you-go dollar invoice. Missing provider usage stays missing; never manufacture zeros or infer cost from the native model catalog's reference rates.

Release of writer exclusion requires correlated settlement of provider, worker process, descendant processes and governed effects. Cancellation/timeout is a request to stop, **not** proof. Unknown outcomes retain both host and BFF safety fences across restarts; see [recovery](recovery.md).
