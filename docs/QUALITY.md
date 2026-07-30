# Quality Strategy

- Harness/docs changes: `node scripts/check-harness.mjs` and `git diff --check`.
- Backend adapter changes: focused unit/service tests for the affected source.
- SDK changes: contract/type tests and downstream compilation.
- GUI changes: focused lint, type, unit, and relevant end-to-end coverage.
- D1 changes: REST transport fixtures, error mapping, binding/identifier cases, batch atomicity, and
  explicit unsupported interactive-transaction tests.
- Cross-source changes: regression tests proving non-D1 behavior remains unchanged.

Use the repository's existing package-level commands for the affected surface. The harness check
protects durable project structure; it does not replace NocoDB's domain checks.
