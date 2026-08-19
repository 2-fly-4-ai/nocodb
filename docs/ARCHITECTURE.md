# Cloudflare D1 External-Source Architecture

```text
NocoDB data-source UI
        |
        v
integration/source services
        |
        v
D1 Knex adapter ----Cloudflare REST API----> external D1 database
```

The adapter validates Cloudflare account/database configuration, translates SQLite-compatible
queries, and executes SQL through the D1 REST endpoint. It can atomically execute a batch only when
all statements and bindings are known before the request.

Interactive read-decide-write workflows, DDL rollback, follow-up audit logging, and dependent writes
are not automatically atomic. `markdown/d1-transaction-audit.md` is the capability authority.

NocoDB metadata storage, upstream database sources, and the schema of attached D1 services remain
outside this fork's ownership.

