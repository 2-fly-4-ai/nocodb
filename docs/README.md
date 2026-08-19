# SERP NocoDB Fork Documentation

This index separates upstream NocoDB documentation from SERP fork decisions.

- [ARCHITECTURE.md](ARCHITECTURE.md) — fork boundaries and D1 external-source architecture.
- [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) — code, capability, release, and plan authority.
- [SAFETY.md](SAFETY.md) — database, data, deployment, and secret gates.
- [QUALITY.md](QUALITY.md) — proportional verification for fork changes.
- [../markdown/d1-transaction-audit.md](../markdown/d1-transaction-audit.md) — D1 transaction
  capabilities, covered paths, and remaining hotspots.
- [plans/README.md](plans/README.md) — canonical dated plan lifecycle.
- [../README.md](../README.md) — upstream product and contributor entrypoint.

Fork-specific durable knowledge belongs under `docs/` or the existing `markdown/` audit. Upstream
product documentation should not be rewritten for fork-only behavior unless that behavior has landed
on the fork default branch.
