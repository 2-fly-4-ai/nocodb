# Sources of Truth

| Question | Primary authority |
| --- | --- |
| What is on the default branch? | `develop` source and Git history |
| What does the D1 feature branch implement? | `codex/cloudflare-d1-support` source and tests |
| Which source capabilities are advertised? | adapter/service contracts plus GUI consumption |
| Is a multi-statement operation atomic? | adapter implementation and targeted transaction tests |
| How do non-D1 sources behave? | upstream implementation and regression tests |
| What is deployed or connected? | approved read-only provider evidence |
| What work is active or complete? | `docs/plans/active/` and `docs/plans/completed/` |

Branch names, plans, comments, and UI labels express intent. They do not override implementation or
prove that a feature is merged, deployed, or connected to a real database.
