# Paperclip Prime Agent adapter

**Explicit prerelease: not live end-to-end qualified.** Controlled native checks passed, but a live provider request remains uncertain and its account-owner fence blocks further use of that subscription. Do not clear or replay that hold.

An opt-in `prime_bff` harness for the **real Prime Agent 0.9.7**, not Pi, OMP, or a Codex replacement. Installing this package does not change existing agents or defaults.

This package requires the matching `@deepextrema/paperclip-primeagent-bff@0.1.0`, the pinned Paperclip host patch/migration, and a locally built, attested native Prime/Python runtime. It is **not** a drop-in adapter for unmodified Paperclip. Node 24.18.0 and the documented Linux x86_64 profile are required.

Use the [source repository](https://github.com/DeepExtrema/Paperclip-primeagent-adapter) and follow the [installation and qualification guide](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/install.md). GitHub releases contain both npm tarballs; neither includes a native runtime. Do not infer live-provider qualification from successful npm installation or the environment probe.

The host retains subscription credentials, tool authorization and effect receipts. Prime uses purpose-scoped IPC and contained Python; uncertain work retains its exclusion rather than being replayed. Read [security](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/security.md) and [recovery](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/recovery.md) before operating it.

MIT licensed. See `LICENSE`, `NOTICE` and `licenses/` for included upstream attributions.
