# Contributing

This is an integration with **three exact upstream revisions and three reviewed patches**, not a fork containing full upstream source trees. Read [architecture](architecture.md), [security](security.md) and [recovery](recovery.md) before changing a trust boundary. Keep changes minimal, reproducible and restricted to the managed opt-in adapter: do not modify other adapter defaults or add fallback providers, generic credential forwarding, optimistic retry, insecure recovery switches or implicit authority promotion.

## Source and build workflow

1. Use Linux x86_64, Node 24.18.0 and npm 11.16.0; for native assembly also Bun 1.4.0, uv 0.12.10, portable CPython 3.14.7, `/usr/bin/bwrap` and GNU `/usr/bin/cp`. The [install guide](install.md) lists the concrete sequence and native build flags.
2. `npm ci`, then `npm run verify:offline` checks the full hash-locked Python-kernel input, builds and typechecks both npm workspaces and runs deterministic Vitest unit tests. `npm run verify:upstream` clones the immutable revisions from `upstream/sources.json` and checks/applies every nonempty patch. CI executes these as separate jobs; neither is live qualification.
3. For a host/native/catalog change, review the changed patch in `upstream/patches/` against its pinned revision and keep the pin, patch and compatibility docs synchronized. Generated DB migration/snapshot must use Paperclip's normal migration process; do not silently renumber or overwrite an existing migration. Do not commit built native binaries, upstream clones, SQLite/WAL, credentials or provider output.
4. If native wheels/dependencies change, refresh both `upstream/python-requirements.lock` and `upstream/python-build-requirements.lock` with exact versions and SHA-256 hashes; rebuild a **new** runtime root and collect redistributed dependency notices. Never use an unpinned remote installer as a substitute for the locked kernel.
5. Report actual checks, artifact hashes and security/continuity effects. Separate offline tests, controlled real-native execution and authenticated end-to-end execution. This prerelease has **not** completed the last category: exact-model catalog admission and native session acceptance succeeded, but a provider request remained uncertain and its account-owner fence blocked another scope. Do not clear that hold to make qualification pass.
6. Treat threshold-compaction token counts as fixture data and hostile Python startup failure as containment evidence, not a working kernel. Review both npm tarballs and license notices. This source-and-two-tarball release ships **no native image**. Anyone separately shipping a compiled Prime executable must audit Bun's static LGPL libraries/polyfills and corresponding source/relink obligations in [licensing](licensing.md). Unit builds, registration and fixtures do not prove live provider, approval or cancellation settlement.

CI uses a disposable Ubuntu 24.04 VM and enables `kernel.apparmor_restrict_unprivileged_userns=0` there because the default restriction denied bubblewrap's network-namespace setup. A real `bwrap --unshare-all` preflight runs before the complete containment suite; tests are not skipped or weakened. This is **not** a recommendation to disable production AppArmor. A production host must provide a security policy that permits the documented namespaces, or native admission fails closed.

## Controlled real-native qualification

After `npm ci && npm run build`, independently assemble a new native runtime as described in [the install guide](install.md). From the public checkout, supply its **absolute normalized assembled runtime root** explicitly; neither command builds a runtime or starts a host/BFF service:

```sh
set -e
RUNTIME_ROOT=/absolute/path/to/assembled-native-runtime
npm run qualify:native -- "$RUNTIME_ROOT"
for scenario in child compaction threshold mcp uncertain hostile hostile-git; do
  npm run qualify:native:advanced -- "$RUNTIME_ROOT" "$scenario"
done
```

Each invocation creates its own fresh private temporary workspace, IPC directory and SQLite database, and prints its local evidence path; never point these commands at production BFF config/DB, a host database, an existing workspace, previous holds or runs. Do not supply provider credentials or commit temporary evidence. To exercise **clean-installed npm tarballs** rather than this checkout's built `dist`, set both `PRIME_BFF_PACKAGE_DIR` and `PRIME_ADAPTER_PACKAGE_DIR` to the absolute directories of the installed packages when invoking either command. The public checkout still provides the fixture authority helper; these overrides select only the compiled package modules under test.

These are **real compiled Prime Agent, bubblewrap, Python kernel, ACP/IPC and SQLite** executions. The baseline asserts persistent Python cells, private-path/credential/network isolation, governed request and finish receipts, a committed checkpoint and resumed native journal, plus a Unicode request exceeding 1 MiB. The advanced scenarios assert bounded children/depth, explicit and automatic compaction, MCP allow/approval/rejection/deny, uncertain cancellation with writer exclusion, and hostile workspace Python imports and Git alias/hooks contained within the worker (the host never executes workspace Git or hooks). Their provider catalog/stream, accounting, governed host/API and MCP receipts are **controlled fixtures**; automatic compaction uses synthetic token counts, not measured provider usage, and the hostile import scenario intentionally fails Python startup closed. None of these commands proves a live subscription-backed managed run, actual host approval, provider settlement or permission to release an unknown hold.

Test with new disposable state, a dedicated workspace and an authorized account only; follow the company's formal `agent-hires` approval flow when required, never disable policy to create a test agent. Do not attach to a running Paperclip server, reuse prior run/hold state, or paste tokens, private issue IDs, user data, auth files or logs into an issue/PR. Preserve unknown holds, including the canaries that failed before observed dispatch; establish original-effect and descendant settlement before any release. Controlled fixtures can cover local invariants but cannot establish absence of duplicate live effects. Security reports involving secrets or bypasses should be sent privately to maintainers rather than published with reproduction credentials.

The repository is MIT; upstream-derived patches retain their upstream MIT attribution. See [licensing](licensing.md) for distribution obligations. Contributions to the original work are submitted under this repository's MIT terms unless a separate notice says otherwise.
