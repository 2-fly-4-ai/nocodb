# SERP NocoDB Fork Architecture

Last reviewed from `develop`: 2026-08-19

## Current Default Branch

The fork's default branch is an upstream-shaped NocoDB application with Cloudflare D1 added as a
first-class external source. It contains the normal backend, SDK, GUI, data-source integrations, and
test surfaces.

```text
NocoDB data-source UI
        |
        v
integration/source services
        |
        +--> existing upstream SQL and external sources
        |
        v
D1 Knex adapter ----Cloudflare REST API----> external D1 database
```

## D1 Capability Boundary

The D1 adapter validates Cloudflare account/database configuration, translates SQLite-compatible
queries, and executes SQL through the Cloudflare D1 REST endpoint. It can atomically execute a batch
only when all statements and bindings are known before the request.

D1 support is external-source only; it does not make D1 the NocoDB metadata database. Cloudflare's
batch interface can make a known, precompiled statement set atomic. It does not provide a long-lived
interactive transaction for read-decide-write workflows.

That boundary must stay explicit in adapter capabilities, services, UI, docs, and tests.
Unsupported transactions must fail clearly or be documented as best effort.
`markdown/d1-transaction-audit.md` is the transaction capability authority.

## Ownership

- `packages/nocodb/` owns backend adapter and service behavior.
- `packages/nocodb-sdk/` owns shared source types and contracts.
- `packages/nc-gui/` owns the data-source configuration experience.
- Upstream owns general NocoDB architecture; SERP owns deliberate fork divergence.
- Cloudflare remote resources and deployment state remain external operational evidence.

## Known Gaps

- Review all D1 write paths for atomicity and truthful capability reporting.
- Complete targeted adapter, service, and GUI coverage.
- Continue auditing schema/DDL and dependent write workflows case by case.
