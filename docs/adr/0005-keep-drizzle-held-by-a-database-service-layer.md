# Keep Drizzle, held by a Database service Layer

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

Adopting Effect (ADR-0002) puts the data layer in question, because Effect has its own SQL
story in `@effect/sql`. We are keeping Drizzle. The schema in
`packages/core/src/backend/lib/db/schema.ts` stays, the query builder stays, and
`drizzle-kit generate` and `drizzle-kit push` remain the migration tooling with no change
to how they are run.

What changes is how the handle reaches a query. A `Database` service, declared with
`Context.Service` (Effect v4's spelling of the service tag), owns the Drizzle instance
and is provided through the Layer graph that
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
  which is what lets a service be exercised without a database. This sentence used to
  claim the Layer made two app instances in one process viable; that is not a goal, and
  one Rova per process remains the only supported arrangement. See the dependency-wiring
  amendment in ADR-0002 (decided 2026-07-28).

## Amendment: the schema name is a runtime option (2026-07-31)

Rova keeps its tables in a Postgres schema the host names, `_workflows` by default. The
tables are therefore declared unqualified in
`packages/core/src/backend/lib/db/schema.ts`, and the connection's `search_path` is the
only thing that decides where they land. `db/index.ts` sends it in the startup packet on
the query client and the migration client alike, so every connection a pool opens, and
every one it reopens after a network drop, is already pointed at the right schema.
Dropping that one schema removes Rova from the database, migration journal included.

A build-time schema name was the alternative, and it fails the case this exists for: an
adopter whose database already has a `workflows` table, or who runs two environments in
one database. Qualifying every table in the generated SQL would also mean the shipped
migrations could only ever build one schema.

- A host's config reaches a pool through `normalizeDatabaseConfig` (`db/config.ts`) and
  no other way. It refuses a config naming no database, a schema name Postgres would not
  read back as written, and a `url` carrying its own `search_path`. That last one matters
  because a URL query parameter reaches the startup packet and outranks the option, so
  the two would disagree about where the tables are.
- Only a connection that keeps the `search_path` startup parameter works, since a pooler
  that swallows it would build the wrong schema silently. `runMigrations` reads
  `current_schema()` back before applying anything and fails naming both schemas, so that
  failure surfaces at the migration rather than in a query downstream. README's database
  options section has the pooler configuration this requires.
- Migrations hold a session-scoped advisory lock, which is why the migration pool is one
  connection. Postgres does not serialize concurrent `CREATE SCHEMA` or `CREATE TABLE` of
  one name; it fails the losers on a unique violation, so replicas starting together used
  to crash all but the first.
- drizzle-kit can no longer be told where the tables are, so `push`, `studio` and `pull`
  are gone and `drizzle.config.ts` carries no credentials. Generating SQL is the one thing
  drizzle-kit still does, offline, and `pnpm run db:migrate` applies it through Rova's own
  migrator. drizzle-kit also writes `REFERENCES "public"."workflows"` for a foreign key
  even where both tables are unqualified, which is why `db:generate` runs
  `scripts/unqualify-migrations.ts` after it.
- `@rova/core/migrate` exists because of this: the shipped SQL names no schema, so nothing
  but Rova's migrator carries the `search_path` that decides which one it builds.
- Four tests guard the arrangement, and they are the reason it can be trusted:
  `db/schema.test.ts` holds every table to naming no schema, `db/migrations-sql.test.ts`
  holds every committed statement to qualifying nothing but Rova's own table names,
  `db/config.test.ts` covers the checks and defaults, and `db/index.test.ts` covers what
  the pools are opened with.
