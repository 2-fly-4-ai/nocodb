# Execution Plans

- `active/YYYY-MM-DD-<slug>.md` contains current approved or in-progress work.
- `completed/YYYY-MM-DD-<slug>.md` contains work with its outcome and evidence recorded.

Keep the opening date when moving a plan. Plans must name the owning packages, upstream baseline,
capability changes, compatibility tests, data-safety constraints, rollout, and rollback.

For D1 work, plans must identify which D1 capability is changed, how non-D1 sources are protected,
targeted test coverage, and whether a multi-step write is atomic or best-effort.

Feature-branch documents and old Markdown audits are inputs until reviewed. Do not bulk-label them
complete or treat them as default-branch authority.
