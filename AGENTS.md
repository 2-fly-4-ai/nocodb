# NocoDB D1 Fork Agent Map

This fork adds Cloudflare D1 as an external NocoDB data source. It does not make D1 the NocoDB
metadata database and does not emulate unsupported interactive transactions.

Read these first:

1. `README.md`
2. `docs/README.md`
3. `docs/ARCHITECTURE.md`
4. `markdown/d1-transaction-audit.md`
5. `docs/plans/README.md`

Key code:

- D1 transport: `packages/nocodb/src/db/sql-client/lib/d1/`
- Source/integration services: `packages/nocodb/src/services/`
- SDK source types: `packages/nocodb-sdk/`
- Data-source UI: `packages/nc-gui/`

Golden rules:

1. D1 external-source capability must remain explicit: atomic precompiled batches are supported;
   long-lived interactive transactions are not.
2. Do not represent best-effort multi-step writes as atomic.
3. Preserve upstream NocoDB behavior for non-D1 sources.
4. Do not run remote D1, production database, schema, deploy, or credential operations without
   explicit approval.
5. Never print or commit account tokens, database credentials, customer rows, or env values.
6. Add targeted adapter/service tests with every D1 behavior change.
7. New plans use `docs/plans/active/YYYY-MM-DD-<slug>.md`.

