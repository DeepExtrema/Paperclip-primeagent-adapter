# Paperclip Prime Agent BFF

**Explicit prerelease: not live end-to-end qualified.** Controlled native checks passed, but a live provider request remains uncertain and its account-owner fence blocks further use of that subscription. Do not clear or replay that hold.

The loopback broker, durable run repository and bubblewrap-contained worker for `@deepextrema/paperclip-primeagent-adapter@0.1.0`. It launches the **real Prime Agent 0.9.7** with a persistent Python kernel. Node 24.18.0 and the documented Linux x86_64 profile are required.

This package does not bundle Prime, Bun, Python, subscription credentials, or a Paperclip database. Build the pinned native sources and apply the matching host patch using the [installation and qualification guide](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/install.md). GitHub releases distribute both matching npm tarballs; install them together.

After preparing the documented private configuration with the actual builder-produced runtime digests:

```sh
paperclip-primeagent-bff --config /srv/paperclip-prime/private/bff.json
```

The service binds only to `127.0.0.1`. Its state root must be private and separate from the immutable runtime and managed workspaces. Do not expose its internal routes, copy another instance's state, remove unknown writer holds, or treat an environment probe as authenticated provider qualification.

See the [architecture](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/architecture.md), [security](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/security.md) and [recovery](https://github.com/DeepExtrema/Paperclip-primeagent-adapter/blob/main/docs/recovery.md) contracts. Existing harness defaults remain unchanged.

MIT licensed. See `LICENSE`, `NOTICE` and `licenses/` for included upstream attributions.
