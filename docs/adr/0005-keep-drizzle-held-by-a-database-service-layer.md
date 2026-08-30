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
`createWfGraphApp` builds. A query runs inside `Effect.tryPromise` and fails with a tagged
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
  one Workflow Graph per process remains the only supported arrangement. See the dependency-wiring
  amendment in ADR-0002 (decided 2026-07-28).

## Amendment: the schema name is a runtime option (2026-07-31)

Workflow Graph keeps its tables in a Postgres schema the host names, `_workflows` by default. The
tables are therefore declared unqualified in
`packages/core/src/backend/lib/db/schema.ts`, and the connection's `search_path` is the
only thing that decides where they land. `db/index.ts` sends it in the startup packet on
the query client and the migration client alike, so every connection a pool opens, and
every one it reopens after a network drop, is already pointed at the right schema.
Dropping that one schema removes Workflow Graph from the database, migration journal included.

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
  failure surfaces at the migration rather than in a query downstream. `docs/embedding.md`
  ("Persistence") has the pooler configuration this requires.
- Migrations hold a session-scoped advisory lock, which is why the migration pool is one
  connection. Postgres does not serialize concurrent `CREATE SCHEMA` or `CREATE TABLE` of
  one name; it fails the losers on a unique violation, so replicas starting together used
  to crash all but the first.
- drizzle-kit can no longer be told where the tables are, so `push`, `studio` and `pull`
  are gone and `drizzle.config.ts` carries no credentials. Generating SQL is the one thing
  drizzle-kit still does, offline, and `pnpm run db:migrate` applies it through Workflow Graph's own
  migrator. drizzle-kit also writes `REFERENCES "public"."workflows"` for a foreign key
  even where both tables are unqualified, which is why `db:generate` runs
  `scripts/unqualify-migrations.ts` after it.
- `@wfgraph/core/migrate` exists because of this: the shipped SQL names no schema, so nothing
  but Workflow Graph's migrator carries the `search_path` that decides which one it builds.
- Four tests guard the arrangement, and they are the reason it can be trusted:
  `db/schema.test.ts` holds every table to naming no schema, `db/migrations-sql.test.ts`
  holds every committed statement to qualifying nothing but Workflow Graph's own table names,
  `db/config.test.ts` covers the checks and defaults, and `db/index.test.ts` covers what
  the pools are opened with.

## Amendment: persistence is a backend-owned adapter (2026-08-11)

Workflow Graph no longer makes its application runtime depend on Drizzle or a
PostgreSQL handle. The runtime accepts the four aggregate repository services as
one persistence Layer. Each backend owns its connection lifecycle, physical
schema, migrations, queries, and concurrency implementation; services and the
run engine continue to depend only on repository contracts.

PostgreSQL keeps the existing Drizzle schema and repository implementations
behind `wfPostgres`. Native Node SQLite is a separate backend behind
`wfSqlite`; it stores each aggregate in normalized,
indexed tables with foreign-key and uniqueness constraints. Repository writes
run inside `BEGIN IMMEDIATE`, making a read/decision/write operation one
transaction. This deliberately serializes SQLite writes and makes the embedded
backend unsuitable for horizontal scale, while preserving the lifecycle,
delivery-idempotency, publish, and wait-claim invariants.

`createWfGraphApp` now takes the resulting opaque `persistence` value rather
than PostgreSQL fields. Separate package entries keep driver-specific factories
out of that contract.

Cloudflare Workers use `wfWorker` with PostgreSQL through Hyperdrive.
The Worker opens and closes its PostgreSQL client per request. The Hyperdrive
binding must have query caching disabled, since cached reads are not invalidated
by writes, and the origin role's default `search_path` must put Workflow Graph's
schema first. The adapter checks `current_schema()` before exposing its
repositories. PostgreSQL migrations remain an out-of-band deployment step for
the Worker host.

## Amendment: the Effect v4 Drizzle bridge arrived, and postgres.js stayed (2026-08-30)

The option rejected above was rejected for a reason that has since expired.
`drizzle-orm@1.0.0-rc.4`, the version in the tree, ships `drizzle-orm/effect-postgres`:
a first-party bridge peering `@effect/sql-pg` and `effect` at
`>=4.0.0-beta.83 || >=4.0.0`, which covers the `4.0.0-rc.112` this repo pins in
`pnpm-workspace.yaml`. `@effect/sql-drizzle`, whose missing v4 release decided the
original question, stayed on its v3 line at 0.51.0 and is no longer the route.

Workflow Graph stays on postgres.js through `drizzle-orm/postgres-js` anyway. The
Effect client is halfway through a rewrite, and two things this repo's PostgreSQL
arrangement is built on have no equivalent in it yet.

**The published client is not the one worth moving to.** `@effect/sql-pg@4.0.0-rc.112`
is the newest release on npm and still runs on node-postgres; its README says so and
`PgClient.ts` is `Pg.Pool` and `Pg.Client` throughout. On the Effect repository's `main`,
`packages/sql/pg/package.json` declares no `dependencies` at all, and `PgClient.ts`
reaches PostgreSQL through the package's own `PgConnection` and `PgPool` over the v3 wire
protocol. Moving today would swap postgres.js for node-postgres and then take the rewrite
as a second migration.

**The startup packet carries three parameters.** `PgConnection` writes `user`, `database`
and `application_name`, and nothing else. `PgProtocol.encodeStartupMessage` iterates an
open record, so the encoder would carry a `search_path`, but no field on `PgClientConfig`,
`PgConnection.Config` or `PgPool.Config` reaches it, and the pool exposes no
per-connection init hook. The schema amendment above rests on that parameter travelling in
the startup packet, and issuing `SET search_path` after checkout is the arrangement it
rejected, because a pool that reopens a connection after a network drop comes back
pointing at the wrong schema.

**Server notices are discarded.** `PgConnection`'s message switch returns on
`NoticeResponse` with no hook, so the routing in `packages/core/src/backend/lib/db/index.ts`
that puts a notice at debug on the `database` logger has nowhere to land. Nothing reaches
a host's stdout either, so the failure is silence rather than the unconfigured printing
ADR-0013 exists to avoid.

**What the native client offers in return** is a zero-dependency driver and a
`stream?: () => Duplex` option that lets the caller supply the socket, which is a cleaner
seam for the Hyperdrive backend in
`packages/core/src/backend/persistence/hyperdrive-postgres.ts` than either driver gives
today.

Four things have to be true before this is worth reopening:

- `@effect/sql-pg` publishes the native client, at a version whose `dependencies` are
  empty.
- Arbitrary startup parameters are reachable from its config, upstream rather than as a
  patch here.
- `drizzle-orm/effect-postgres` is verified against the rewritten `PgClient`. Drizzle's
  peer range predates the rewrite, and the client's `types` option changes shape from
  `Pg.CustomTypesConfig` to the package's own `PgTypes.Registry`.
- Losing server notices is accepted, or a hook for them exists.

The payoff is bounded and known. Five source files import postgres.js:
`backend/lib/db/index.ts`, `backend/lib/db/migrations.ts`,
`backend/persistence/hyperdrive-postgres.ts`,
`backend/persistence/postgres-test-database.ts` and `src/migrate.test.ts`, all under
`packages/core`. Queries would arrive as Effects, which retires the `Effect.tryPromise`
wrapper in `packages/core/src/backend/lib/effect/database.ts`, the boilerplate this ADR's
Consequences named. The repository contracts and the Drizzle schema are unaffected either
way.
