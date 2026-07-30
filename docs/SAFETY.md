# Safety and Operator Gates

Do not run remote D1 calls, database commands, schema changes, migrations, seeds, deployments,
credential changes, or customer-data inspection without explicit approval for the exact target.

- Use synthetic fixtures in tests.
- Never print or commit Cloudflare tokens, database credentials, customer rows, exports, or env
  values.
- Preserve unrelated local work and upstream-compatible behavior.
- Review unfamiliar test/setup scripts before running them; a test command may provision services.
- Do not merge the D1 feature as part of documentation cleanup. It requires its own code review,
  rebase, compatibility verification, and rollout decision.

Before an approved data operation, identify the account, database, environment, exact command,
expected writes, recovery path, and evidence that will be collected without exposing data.
