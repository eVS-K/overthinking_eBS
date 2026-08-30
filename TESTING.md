# Testing

`npm test` is intentionally the fast, local Node suite. It includes pure game
rules, Ranked logic, API/auth checks, UI contract checks, and a real local
Socket.IO lifecycle test. It never needs OAuth, a browser download, or a
database connection.

```powershell
npm test
```

Before a release or pull request, run the lightweight syntax check and the
core-game coverage gate as well:

```powershell
npm run check
npm run test:coverage
```

The coverage gate protects the pure, high-risk game modules rather than using
a misleading repository-wide percentage that would be inflated by static UI
files. It evaluates each core module independently, so a fully covered helper
cannot hide weak coverage in the Ranked or Private state engines. Thresholds
are tailored to the module's risk and current meaningful boundary coverage;
the strictest modules require 98%+ lines, 90%+ branches, and 100% functions.

## Isolated PostgreSQL integration tests

`npm run test:postgres` **drops and recreates the `public` schema** of its
target database before applying all migrations. It is therefore deliberately
separate from `npm test` and refuses to run unless all of the following are
true:

- `RUN_POSTGRES_INTEGRATION=1`
- `TEST_DATABASE_URL` is set (it never reads `DATABASE_URL`)
- the database name visibly contains `test` or `testing`
- its resolved host/port/database differs from `DATABASE_URL`
- non-local hosts also require `ALLOW_REMOTE_TEST_DATABASE=1`

Use a disposable local database, never the Render/Supabase production
database. The test role must own its `public` schema, be able to create roles
and schemas, and have `pgcrypto` available. For example, after starting a
local PostgreSQL instance:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "1"
$env:TEST_DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/overthinking_test"
npm run test:postgres
```

This suite verifies real migrations, schema placement, RLS and browser-role
privileges, partial unique indexes, row-lock/idempotency races, Rating
finalization, preset ownership/limits, and transaction rollback behavior.

## CI

The GitHub Actions workflow runs the fast suite plus coverage on Ubuntu, the
fast suite on native Windows, and `test:postgres` in a fresh PostgreSQL service
on every push and pull request. Browser E2E is intentionally not part of this
first test-basis upgrade: it needs stable browser fixtures for Socket.IO and
OAuth-free Ranked responses, so it should be added as a dedicated, isolated
Playwright job rather than making local `npm test` fragile.
