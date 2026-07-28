# Keep Drizzle, held by a Database service Layer

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

Adopting Effect (ADR-0002) puts the data layer in question, because Effect has its own SQL
story in `@effect/sql`. We are keeping Drizzle. The schema in
`packages/core/src/backend/lib/db/schema.ts` stays, the query builder stays, and
`drizzle-kit generate` and `drizzle-kit push` remain the migration tooling with no change
to how they are run.

What changes is how the handle reaches a query. A `Database` service, declared with
`Context.Tag`, owns the Drizzle instance and is provided through the Layer graph that
`createRovaApp` builds. A query runs inside `Effect.tryPromise` and fails with a tagged
`DatabaseError`, which puts database failure in the caller's error channel where the type
system can see it. The
`globalThis` Proxy in `packages/core/src/backend/lib/db/index.ts` that currently makes the
handle reachable from anywhere is deleted as part of the runtime work in ADR-0002.

## Considered Options

- **Migrating to `@effect/sql-pg`** rejected: `@effect/sql-drizzle` has no v4 release, only
  a v3 line, so there is no supported bridge from Drizzle to the Effect version we are
  adopting. Taking `@effect/sql-pg` therefore means rewriting every query off Drizzle's
  builder and replacing the drizzle-kit migration flow at the same time, a full data-layer
  rewrite stacked on an already large migration. Worth revisiting once an Effect v4
  Drizzle bridge exists.

## Consequences

- Drizzle's Promise-returning builder sits behind an `Effect.tryPromise` wrapper at every
  call site, which is boilerplate the `Database` service should absorb where the shape
  repeats.
- Postgres error detail arrives as whatever `postgres.js` throws, so `DatabaseError` has
  to carry the cause if constraint violations are to be distinguished from connection
  failures further up.
- Passing a `Database` Layer in tests replaces reaching for the module-level `db` export,
  which is what makes two app instances in one process viable.
