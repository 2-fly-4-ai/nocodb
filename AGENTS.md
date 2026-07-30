# NocoDB Fork Agent Map

This is SERP's NocoDB fork. The default branch follows upstream NocoDB; Cloudflare D1 external
source work currently lives on `codex/cloudflare-d1-support` and is not default-branch behavior.

Read these first:

1. `README.md`
2. `docs/README.md`
3. `docs/ARCHITECTURE.md`
4. `docs/SOURCE_OF_TRUTH.md`
5. `docs/SAFETY.md`
6. `docs/QUALITY.md`
7. `docs/plans/README.md`

Important areas:

- `packages/nocodb/`: backend and source-integration behavior.
- `packages/nocodb-sdk/`: shared SDK contracts.
- `packages/nc-gui/`: data-source UI.
- `tests/`: integration and end-to-end coverage.
- `markdown/`: upstream and feature-specific design/audit documents.

Golden rules:

1. Preserve upstream behavior for existing sources and keep fork divergence reviewable.
2. Do not describe feature-branch code as merged or deployed.
3. A D1 adapter may support atomic precompiled batches without supporting long-lived interactive
   transactions; never represent best-effort multi-step writes as atomic.
4. Do not run remote D1, database, schema, migration, deploy, credential, or customer-data
   operations without explicit approval.
5. Never print or commit account tokens, credentials, customer rows, exports, or env values.
6. Add targeted adapter/service tests for data-source behavior changes.
7. New plans use `docs/plans/active/YYYY-MM-DD-<slug>.md`.
