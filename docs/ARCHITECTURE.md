# SERP NocoDB Fork Architecture

Last reviewed from `develop`: 2026-07-30

## Current Default Branch

The fork's default branch is an upstream-shaped NocoDB application. It contains the normal backend,
SDK, GUI, data-source integrations, and test surfaces. SERP's Cloudflare D1 external-source adapter
is currently isolated on `codex/cloudflare-d1-support`.

```text
NocoDB GUI
    |
    v
source/integration services
    |
    +--> existing upstream SQL and external sources
    |
    +--> D1 REST adapter (feature branch only)
```

## D1 Capability Boundary

The feature branch adds D1 as an external data source; it does not make D1 the NocoDB metadata
database. Cloudflare's batch interface can make a known, precompiled statement set atomic. It does
not provide a long-lived interactive transaction for read-decide-write workflows.

Any eventual merge must keep that boundary explicit in adapter capabilities, services, UI, docs,
and tests. Unsupported transactions must fail clearly or be documented as best effort.

## Ownership

- `packages/nocodb/` owns backend adapter and service behavior.
- `packages/nocodb-sdk/` owns shared source types and contracts.
- `packages/nc-gui/` owns the data-source configuration experience.
- Upstream owns general NocoDB architecture; SERP owns deliberate fork divergence.
- Cloudflare remote resources and deployment state remain external operational evidence.

## Known Gaps

- Rebase the D1 branch onto the current fork default and resolve upstream drift.
- Review all D1 write paths for atomicity and truthful capability reporting.
- Complete targeted adapter, service, and GUI coverage.
- Decide whether the feature is ready for a separate default-branch merge PR.
