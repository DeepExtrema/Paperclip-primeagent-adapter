# Install and qualify

This is a **pinned-source, Linux x86_64, managed-local** installation, not a drop-in package for unmodified Paperclip. Install it into a *fresh, operator-owned deployment* with no other Prime writer. Never point it at another installation's database, SQLite WAL, runtime state, or workspace. The source checkouts made by `verify:upstream` live under this repository's ignored `.upstream/`; they are not installed automatically into a host. Keep the BFF state, host database, workspace and native runtime on distinct canonical paths.

## 1. Prerequisites and immutable sources

Use Linux x86_64 with Node **24.18.0**, npm **11.16.0**, Bun **1.4.0**, uv **0.12.10**, a portable CPython **3.14.7** prefix, Git, `/usr/bin/bwrap` and GNU coreutils `/usr/bin/cp` for the pinned native build. Keep the source/build directories, portable Python prefix, assembled native runtime and BFF state private to the operator; install the runtime read-only for the BFF service identity. The build script rejects incompatible versions and expects **absolute normalized paths** for all build flags. Do not swap in ambient Python or a Prime CLI installed from an unpinned package.

From the public repository root:

```sh
npm ci
npm run verify:offline
SOURCES_JSON="$(node scripts/verify-upstream.mjs | tail -n 1)"
```

The final command clones all three exact revisions in [`upstream/sources.json`](../upstream/sources.json), checks each pinned SHA and applies its **required, nonempty** reviewed patch in a newly created `.upstream/pinned-*/` directory; its last stdout line is the absolute `sources.json` path. Its clone requires network; if it fails, do not continue assembly. `npm run verify:upstream` invokes the same source check (also a CI job). The host patch includes `0294_prime_runtime` migration; run normal host migrations for the fresh host before enabling Prime. Do **not** point a patched host at another deployment's historical DB or invent a migration reset procedure.

`verify:offline` performs the kernel lock check, adapter/BFF TypeScript builds and typechecks, and deterministic unit tests. CI's separate `pinned-source-patches` job checks clean clone/patch application. These are not live-provider, OS-containment or managed-session qualification. The script `build-native.mjs` accepts **the printed `sources.json` from that same clone**; `--output` must be a new, absent runtime root and `--python-prefix` an existing, portable 3.14.7 prefix. Example profile (supply the actual paths to operator-installed binaries/prefix, not a system Python alias):

```sh
node scripts/build-native.mjs \
  --sources "$SOURCES_JSON" \
  --python-prefix /srv/paperclip-prime/toolchain/python-3.14.7 \
  --output /srv/paperclip-prime/runtime/native-0.9.7 \
  --bun /srv/paperclip-prime/toolchain/bin/bun \
  --uv /srv/paperclip-prime/toolchain/bin/uv \
  --uv-version 0.12.10
```

The `--sources` value is the **actual absolute file printed by `verify-upstream.mjs`**, not an arbitrary file copied from somewhere else. The builder verifies all three pinned Git revisions and reverse-applicability of their patches. It generates Prime catalog assets, builds the actual Prime Agent Linux executable, installs the full hash-locked Python kernel requirements plus a separately hash-locked build backend in a temporary build environment, builds/installs the real Prime Python wheel offline, gathers native dependency license notices, and prints JSON with `executable`, `executableSha256`, `runtimeRoot`, `runtimeSha256`. Retain those four values with the immutable runtime; the BFF recomputes both digests at startup. Reusing or modifying a runtime root invalidates the recorded digests. Native assembly can download already pinned dependencies; `--offline` applies to the wheel build, not to every prior dependency acquisition.

The adapter npm package has a *peer dependency* on `@paperclipai/adapter-utils@0.3.1`. The BFF depends on the matching adapter package; build/install both at compatible versions, using the public workspace `npm ci && npm run build`. Pack the separately built workspaces as the adapter and BFF npm tarballs (`npm pack -w @deepextrema/paperclip-primeagent-adapter` and `npm pack -w @deepextrema/paperclip-primeagent-bff`); install each package from its actual `.tgz` file or published package name, rather than pointing a production install at a source-checkout path. The **public artifacts are this source/patch/lock repository and those two npm tarballs only**: neither tarball bundles `node_modules`, Bun/Prime binaries, or the Python kernel, and no precompiled native runtime is distributed on GitHub. The operator assembles actual Prime locally with the pinned source and `build-native.mjs` above. Npm installation alone cannot add the required patched host hooks/migration or a native image. If someone separately redistributes a compiled native binary, the [additional static-library and source/relink obligations](licensing.md) apply.

## 2. Start the standalone BFF

Prepare a new, private, canonical state directory (owner-only directory mode `0700`) **outside** runtime and workspace roots. The BFF creates its own SQLite `prime-runs.sqlite` with WAL sidecars, an owner lock, a 32-byte control secret and immutable settled checkpoints. Its database is not the Paperclip host database. Create an owner-only JSON config file in a private directory with **exactly** these keys (use the four literal path/digest strings printed by `build-native.mjs`):

| Key | Value |
| --- | --- |
| `stateRoot` | Absolute normalized private BFF state directory, separate from runtime and workspace |
| `paperclipApiUrl` | Actual loopback Paperclip API origin, with no credentials or URL fragments |
| `port` | Explicit available BFF TCP port (the adapter's default URL uses `4319`) |
| `executable`, `executableSha256` | Native binary path and its builder-produced SHA-256 |
| `runtimeRoot`, `runtimeSha256` | Complete native runtime root and its builder-produced tree SHA-256 |

Start the built BFF with `node packages/bff/dist/index.js --config /srv/paperclip-prime/private/bff.json` (or the `paperclip-primeagent-bff --config` package binary). The service binds **127.0.0.1 only** and rejects invalid runtime/bwrap/owner permissions or digests. Do not publish or proxy its `/internal/paperclip/prime-runs` routes. Set the per-agent `bffBaseUrl` to its matching `http://127.0.0.1:4319` origin; see [configuration](configuration.md). The BFF `capabilities` route and adapter `testEnvironment` only check the protocol/port; the latter explicitly warns that subscription catalog admission happens later.

## 3. Register without changing defaults

Apply the pinned host patch to the matching Paperclip revision and build/migrate that host with its normal install instructions. The patched host's **instance-admin-only** API installs a *locally built checkout* with the following demonstrated request; code installation must be permitted by the host's own admin policy. Use an authenticated administrator session and do not save a bearer in command history, docs or logs. The `packageName` value is the actual canonical local adapter package directory; it is not the workspace root:

```http
POST /api/adapters/install
Content-Type: application/json
Authorization: Bearer (administrator credential supplied out of band)

{"packageName":"/srv/paperclip-prime/public/packages/adapter","isLocalPath":true}
```

On a fresh isolated API-only host this local-path shape returned `201` with type `prime_bff`, version `0.1.0`, `requiresRestart:false`; `GET /api/adapters/prime_bff` returned `loaded:true`, `disabled:false`, `source:"external"`. For an already published package, source code also accepts `{"packageName":"@deepextrema/paperclip-primeagent-adapter","version":"0.1.0"}` without `isLocalPath`; **registry installation was not exercised**. Host UI installation is a source-supported option, not an observed UI test.

For a **new opt-in canary**, follow the company's existing agent-hire policy. If `requireBoardApprovalForNewAgents` is enabled, submit the normal hire request with explicit `prime_bff` selection and subscription binding; do **not** disable the policy or use direct creation to bypass the board. Use a real, already existing dedicated workspace instead of this example root:

```http
POST /api/companies/:companyId/agent-hires
Content-Type: application/json
Authorization: Bearer (authorized operator credential supplied out of band)

{"name":"Managed Prime agent","role":"general","adapterType":"prime_bff","adapterConfig":{"cwd":"/srv/paperclip-prime/workspace","model":"gpt-6.1-sol","bffBaseUrl":"http://127.0.0.1:4319"},"runtimeConfig":{"aiConnection":{"provider":"openai","method":"subscription","mode":"responsible_user"}}}
```

Under an approval-required company, this route creates a `pending_approval` agent and linked `hire_agent` approval; complete the company's normal board approval before it can run. The response wraps the agent and approval (`{"agent":...,"approval":...}`), not a directly active agent. Where company policy **permits direct agent creation**, the same opt-in agent/config/binding fields may instead be sent to `POST /api/companies/:companyId/agents`; an isolated API-only host returned `201` for direct creation without the subscription binding and left an unrelated `codex_local` agent unchanged. That earlier registration test did not exercise a subscription. Creating or approving a hire does **not** authorize a provider call: select an eligible real `runtimeConfig.aiConnection` grant and responsible user, assign a new issue to the preprovisioned active execution workspace and follow normal issue workflow. See [configuration](configuration.md); no global/default migration occurs.

The exercised `POST /api/companies/:companyId/adapters/prime_bff/test-environment` returned `status:"fail"` (`prime_bff_available: fetch failed`) with no BFF listening. Once the actual standalone BFF started, `GET /internal/paperclip/prime-runs/capabilities` returned HTTP `200` with `protocolVersion:3` and `containmentProfile:"paperclip-workspace-write-v3"`; the fresh host's environment probe then returned HTTP `200`, `status:"warn"`, `prime_bff_available` reachable and `prime_bff_authenticated_catalog` warning. This proves only loopback reachability/protocol and defers authenticated catalog checks to run admission: there was **no** account, worker or provider execution in these probes.

## 4. Distinguish diagnostics from managed qualification

An offline build, pinned patch check, successful external registration and adapter environment probe are non-provider diagnostics. Controlled-broker tests **did** run compiled Prime 0.9.7 and its contained Python kernel: persistent cells, a settled checkpoint and continued native journal, bounded children, explicit/threshold compaction, governed finish and MCP approval/rejection with original-effect reconciliation, retained unknown cancellation, >1 MiB Unicode IPC and containment probes. Provider responses, token counts used to trigger threshold compaction and governed API receipts in those tests came from fixtures, not a subscription: the threshold fixture reported 785,005/800,000 tokens over a real 2.3 MiB input, **not** actual live usage. One hostile Python startup injection failed safely without a working kernel; an invoked malicious Git hook was contained. Neither result is a general security guarantee. See the [qualification matrix](../README.md#exercised-verification).

**This remains an explicit prerelease; a bounded subscription-backed Python/artifact acceptance passed on 2026-10-10 UTC.** Against source `6d42bb4149eadba60f1a61b982d984a8d47677ce`, actual Prime used exact model `gpt-6.1-sol`, completed three correlated provider requests, preserved Python state across two cells, saved a nonce-bearing proof and issue document, and finalized the issue through Paperclip's normal review gate. Host and native settlement, stopped descendants, released BFF writer lease and a sealed checkpoint were independently observed. The operator then marked the task done. This does not establish live children, MCP approval, cancellation, compaction or checkpoint continuation. Earlier uncertain provider/workspace holds and a separate rejected-finalization hold remain unchanged; see the [qualification matrix](../README.md#exercised-verification).

The `v0.1.0` tag predates the credential-owner, Codex response-admission, authorization-refresh and metadata-only session-admission repairs. Rebuild the pinned host using the current complete `paperclip.patch`; replacing only npm packages does not apply those corrections. The non-admission recovery path additionally requires the rebuilt BFF and its additive standalone schema 32 migration. Package versions remain 0.1.0; protocol v3, adapter runtime and the exact attested native image are unchanged. Preserve the existing private state and original receipts when upgrading an authorized incident; do not roll an older BFF back onto the newer schema. If an older account marker remains, follow the individually evidenced [credential recovery procedure](recovery.md), or authorize a distinct eligible subscription. Never clone credentials or equate missing local processes with provider settlement.

Each deployment's live qualification requires separate authorization for a **new issue/run in a fresh dedicated workspace**, with an explicit exact model and host-held subscription selection. Do not reuse a held workspace. Preconfigure a real [review path](configuration.md#run-behavior-and-issue-status) if the task will request `in_review`; an evidence document or summary alone does not satisfy that gate. Observe a real contained Prime turn, exact provider/model, per-run usage, immutable checkpoint and correlated settlement. A continuation must resume that checkpoint in the same authorized scope. Provider calls can consume subscription allowance.

If testing cancellation or approval, use a separately authorized disposable effect, confirm the original receipt and settlement, and preserve unknown holds instead of redispatching. Record the exact artifact revision, runtime digests, observations and limits before claiming production readiness. GitHub prerelease assets include both npm tarballs and `SHA256SUMS`; no npm-registry publication or prebuilt native image is implied.

Do not use the BFF run endpoint manually with a fabricated authority; it only admits purpose-specific, signed capabilities issued for a genuine Paperclip run. See [recovery](recovery.md) for safe stop/upgrade behavior.
