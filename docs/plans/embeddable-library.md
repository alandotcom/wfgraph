# Plan: make Workflow Graph a library anyone can embed

Goal: someone clones nothing, runs `bun add @wfgraph/core`, mounts it inside their existing
app on whatever HTTP framework they already run, and defines actions and triggers driven
by their own data model and their own Inngest events.

This plan is written to be executed by a fresh session with no memory of the review that
produced it. Every finding below was verified against the code at commit `a59db6b`.

## The unifying decision

The mounted thing becomes a **fetch handler**: `(request: Request) => Promise<Response>`.

Hono stays inside as an implementation detail. That one change does four things at once:

- Bun, Deno, Cloudflare Workers, and Node 18+ all consume it directly.
- `hono` leaves `peerDependencies`, so an Express adopter stops having to install a web
  framework they are not using.
- The exported type stops naming a third-party class, so swapping the router later is an
  internal change.
- Express and Fastify support reduces to one small translator that Workflow Graph owns, instead of
  a recipe every adopter reimplements.

What a fetch handler does not solve by itself: Node's `http` module speaks
`IncomingMessage`/`ServerResponse`, so Express and Fastify hosts need a translator, and
that translator has two failure modes that must be handled inside the library rather than
documented at adopters (see Phase 2).

## Verified findings this plan addresses

| #   | Finding                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mount prefix is inferred by URL arithmetic, which breaks under any host that rewrites `req.url` on mount (Express `app.use("/wfgraph", ...)` does)                                                                                                                               | `packages/core/src/backend/app.ts:149`; client reads it back via `<base href>` at `packages/core/client/index.html:12` and `client/lib/rpc-client.ts:108`                                                                                                              |
| 2   | Two embedding surfaces implement the same job twice and have already drifted                                                                                                                                                                                                     | `packages/core/src/hono.ts` (310 lines) vs `packages/core/src/server.ts` (581 lines); `encryption` required at `hono.ts:77`, optional at `server.ts:59`; plugins imported at `hono.ts:30`, absent from `server.ts`; registration state in a closure vs on `globalThis` |
| 3   | README says `startWfGraphServer` wraps `createWfGraphApp`. It does not; it calls `createApiApp` directly and reimplements static serving, registration, and teardown                                                                                                             | `README.md:176`, `packages/core/src/server.ts:437`                                                                                                                                                                                                                     |
| 4   | The published tarball is 11.67MB because five vendor SDKs are inlined                                                                                                                                                                                                            | `hono.ts:30-36` imports `@/plugins/*`, which `tsconfig.build.json` maps into `packages/plugins/src`; `bun pm pack` emits chunks holding twilio, `@linear/sdk`, `@slack/web-api`, `@clerk/backend`, and resend, none of them declared in `packages/core/package.json`   |
| 5   | `@wfgraph/core/server` is imported by `server.ts:3` and `examples/library-trigger.ts:2` but absent from the `exports` map and from the tsdown entry list. AGENTS.md:91 says it is the server entry, README:176 says it is unpublished                                            | `packages/core/package.json`, `packages/core/tsdown.config.ts`                                                                                                                                                                                                         |
| 6   | A host cannot define a credential-holding integration. `IntegrationType` is a closed union of seven strings and `registerIntegration` accepts nothing else                                                                                                                       | `packages/shared/src/types/integration.ts:1`, `packages/shared/src/plugins/registry.ts:248`                                                                                                                                                                            |
| 7   | The mounted app has no seam for authentication. `WfGraphAppOptions` offers no hook, and API keys gate only the webhook path                                                                                                                                                      | `packages/core/src/hono.ts:69`, `packages/core/src/backend/services/workflows/workflow-webhook.workflows.ts:80`                                                                                                                                                        |
| 8   | Two functions named `registerRuntimeAction` write to two different stores with different semantics                                                                                                                                                                               | `packages/shared/src/plugins/registry.ts:261` (plain set, used by the browser) and `packages/shared/src/workflow/action-registry.ts:384` (normalizes and wraps `execute`, used by the server)                                                                          |
| 9   | Database, Inngest, encryption, and both registries are process-global singletons, so one process holds exactly one Workflow Graph                                                                                                                                                | `packages/core/src/backend/lib/db/index.ts:124` and the `configure*` family                                                                                                                                                                                            |
| 10  | The built bundle imports `axios` at runtime and no package.json declares it. It resolves here only because Twilio hoists it into the workspace `node_modules` through `@wfgraph/plugins`. An outside adopter gets `Cannot find module 'axios'` the first time a Twilio step runs | `packages/core/dist/test-CNx817mJ.js` holds `from "axios"`; `packages/core/package.json` never names it                                                                                                                                                                |
| 11  | `hono` is the one peer dependency in the repo, so the adopter installs the web framework the interface exposes                                                                                                                                                                   | `packages/core/package.json:73`                                                                                                                                                                                                                                        |

What already works and must not regress:

- `/api/extensions` (`app.ts:314`) ships runtime action and trigger metadata to the browser,
  which re-validates it in `client/lib/runtime-extensions.ts` and registers it locally. A
  host-defined action renders in the editor with a config form and template autocomplete,
  with no client rebuild. This is the load-bearing piece of the whole product.
- `pgSchema("_workflows")` (`db/schema.ts:16`) namespaces every table, so the library lands
  in a host database without colliding.
- The published bundle touches no Bun global and imports cleanly under plain Node
  (`node -e 'import("./packages/core/dist/hono.js")'` succeeds today).

## Phases

Each phase ends at a green tree and a commit. Stopping after any phase leaves the repo in
a better state than it started. Run the full check list from AGENTS.md before every commit:
`bun run type-check`, `bun run lint`, `bun test`, `bun run build`, `bun run knip`, `bun run fix`.

### Phase 1 -- The mounted app becomes a fetch handler

Addresses findings 1 and, in part, 3.

1. Change `WfGraphApp` in `packages/core/src/hono.ts` to `{ fetch: (request: Request) => Promise<Response>, dispose: () => void }`.
   Keep the internal Hono app private to the module.
2. Add `basePath?: string` to `WfGraphAppOptions`, defaulting to `"/"`. Thread it into
   `createApiApp` and into the `<base href>` rewrite.
3. Delete `computeMountPrefix` and the `resolvePrefix` inference in `app.ts`. The host knows
   where it mounted the app, so ask it once instead of deducing it per request. This removes
   a class of bug rather than handling it.
4. Move `hono` from `peerDependencies` to `dependencies` in `packages/core/package.json`,
   emptying the peer surface (finding 11). Nothing an adopter installs by hand should be
   required to make the mounted app work. It stays a separate import rather than being
   inlined, so a host already running Hono dedupes against their copy.
5. Drop `@hono/zod-validator` (5 uses) in favor of `schema.parse(await request.json())` at the
   route, which is what AGENTS.md already asks for at the boundary. It is a shallow wrapper
   and it carries its own peer requirement on hono.
6. Rename the entry from `@wfgraph/core/hono` to `@wfgraph/core/app`, renaming `src/hono.ts` to
   `src/app.ts` and updating the `exports` map and the tsdown entry list together. A subpath
   that names the router contradicts hiding it, and it is the last place the interface tells
   an adopter which framework runs inside. Note `src/backend/app.ts` already exists, so pick
   the final names deliberately rather than colliding.
7. Update `README.md` embedding section and the options table.

**Hono stays, and this is settled.** Once Phase 1 hides it, an adopter never names it. Two
files import it, `app.ts` defines 15 routes, and the context surface in use is `c.req.raw`
(9), `c.json` (9), `c.req.header` (7), `c.req.path` (5), `c.req.valid` (4), `c.newResponse`
(4), `c.req.query` (2). Nearly every handler already reduces to a raw `Request` handed to
oRPC or Inngest, both fetch-native, and inngest 4.13.0 ships an `./edge` export serving a
plain fetch handler, so removal is feasible. It is still the wrong trade: Hono supplies
method and path matching, params, the middleware chain, and correct 404s, and this codebase
has already hand-rolled path normalization and traversal guards twice (`hono.ts:143`,
`server.ts:170`), which is the bug class a hand-rolled router invites. A hidden dependency
off the peer list costs one small package; replacing it is churn with no adopter-visible
gain. Do not reopen this without a new reason.

Acceptance:

- `Bun.serve({ fetch: wfgraph.fetch })` serves the editor and runs a workflow.
- A test asserts that `basePath: "/wfgraph"` produces `<base href="/wfgraph/">` and an oRPC prefix
  of `/wfgraph/api/rpc`, and that the default produces `/`.
- `packages/core/package.json` has no `peerDependencies` block at all.

Commit: `Expose the embedded app as a fetch handler`

### Phase 2 -- One translator for Node-based hosts

Addresses the Express and Fastify question directly.

1. Add `packages/core/src/node.ts`, exported as `@wfgraph/core/node`, with
   `createRequestListener(wfgraph: WfGraphApp): (req: IncomingMessage, res: ServerResponse) => void`.
   Add the entry to `tsdown.config.ts` and to the `exports` map together, since they must
   agree (see finding 5 for what happens when they do not).
2. Build the `Request` from `req.originalUrl ?? req.url`. Express rewrites `req.url` to strip
   the mount path, and `req.originalUrl` is the only place the full path survives. This is
   the hazard that silently breaks asset loading and the RPC prefix under `app.use("/wfgraph", ...)`.
3. Handle the consumed-body hazard explicitly. If the host mounted a body parser first,
   `req` is already drained and every POST arrives empty, including the Inngest signature
   check, which needs exact bytes. Detect a populated `req.body` with a drained stream and
   throw a named error naming the fix, rather than serving a silent 400. Re-serializing a
   parsed body is not an option because it changes the bytes the signature covers.
4. Write integration tests that boot a real Express app and a real Fastify app, mount Workflow Graph
   under a sub-path, and drive a workflow through each: fetch `/wfgraph/api/extensions`, save a
   workflow over RPC, POST a webhook trigger. These are the tests that would have caught
   findings 1 and 5.
5. Document all three mounts in the README: fetch-native runtimes, Express, Fastify.

Open question for the executing session: whether to depend on `@hono/node-server` for
`getRequestListener` or hand-roll roughly 60 lines. Check the current version and its
Node floor with Context7 before deciding. Hand-rolling keeps the dependency count down and
keeps the `originalUrl` handling in our own hands; the library version is better tested.
Prefer the library unless its API forces the `originalUrl` workaround into adopter code.

Commit: `Mount the embedded app on Node request listeners`

### Phase 3 -- One implementation of the server

Addresses findings 2, 3, and 5.

1. Rewrite `packages/core/src/server.ts` so `startWfGraphServer` calls `createWfGraphApp` and
   passes the result to `Bun.serve`, keeping only what is genuinely Bun-specific: the
   `clientHtml` HTML-import route and the signal handlers.
2. Delete the duplicated client-directory resolution, the duplicate path-traversal guard,
   the duplicate SPA fallback, the duplicate registration and teardown, and the duplicate
   options type. `WfGraphServerStartOptions` becomes `WfGraphAppOptions & { port?, clientHtml?, installSignalHandlers? }`.
3. Resolve the `encryption` inconsistency in favor of the stricter contract, per the
   no-backwards-compatibility rule: required, validated at startup, same in both places.
4. Unpublish `@wfgraph/core/server`. Move what survives into the repo's own top-level
   `server.ts` and drop the package entry. Once it is a wrapper over `createWfGraphApp` plus
   `Bun.serve`, what it saves an outsider is two lines, and what it charges is an options
   type that will reaccumulate every `Bun.serve` parameter adopters want to ask through it.
   Its distinctive options serve this repo rather than a consumer: `clientHtml` exists so
   development needs no client build, and a published consumer has a prebuilt client in
   `dist` with no client source to transpile, while its `HTMLBundle` type would drag `bun`
   types into a published surface. The `globalThis.__wfgraphServerRuntimeState` guard
   (`server.ts:98`) serves the hot-reload loop. Bun is also the runtime where the Phase 1
   fetch handler needs no adapter at all, so a Bun-only wrapper undercuts the thesis that
   the fetch handler is the one surface.
5. Rewrite `examples/library-trigger.ts` against `createWfGraphApp` plus `Bun.serve`, which
   turns the example into documentation of the real adopter path.
6. Correct `AGENTS.md:91` to match. `README.md:176` already describes the outcome, so the
   code moves to the documentation rather than the reverse, which closes finding 5.

Acceptance: `bun run dev` still serves a transpiled-per-request client with no client build,
which is the behavior `clientHtml` exists to protect. `examples/library-trigger.ts` runs.

Commit: `Start the Bun server from the embedded app`

### Phase 4 -- Stop vendoring the integration SDKs

Addresses finding 4.

1. Remove the `import "@/plugins/*"` block at `hono.ts:30-36`.
2. Add a `packages/core/src/plugins.ts` entry, exported as `@wfgraph/core/plugins`, whose only
   job is to import and register the built-ins. Adopters who want Slack and Twilio import it;
   adopters who want only their own actions pay nothing.
3. Drop `private: true` from `packages/plugins/package.json` and give it a build, so the
   built-ins are installable rather than inlined. Its SDK dependencies then live where the
   code that imports them lives, which is what the isolated-linking rule in AGENTS.md asks for.

   **Regular dependencies, not peers.** Peer dependencies earn their cost when the package
   has identity that must be shared across the boundary, as React and ESLint plugins do.
   Workflow Graph constructs every vendor client itself from credentials it decrypts out of the
   `integrations` table (`send-sms.ts:148` calls `twilio(accountSid, authToken)`), so no
   adopter hands us an instance, nothing checks `instanceof` across the boundary, and a
   duplicate copy in the tree costs only bytes. A peer here would buy no correctness and
   charge a manual install, which is the thing Phase 1 removes. Pay-per-use is already
   covered: `@wfgraph/plugins` is a separate install from `@wfgraph/core`, so a core-only adopter
   pays nothing, and after Phase 5 the list is two SDKs. If per-integration granularity is
   ever wanted, split per-integration packages rather than reaching for optional peers plus
   lazy `import()`, which converts a missing install into a runtime failure mid-step. An
   adopter who wants their own configured client writes their own action under Phase 7, and
   the dependency lands in their `package.json`.

4. Narrow the `@/*` alias in `tsconfig.json` and `tsconfig.build.json`. Today it resolves
   against four directories in order, which is how `hono.ts` reached into another package's
   source in the first place. Give each package its own prefix and let a wrong import fail.
5. Add a test that enumerates every bare import in `packages/core/dist/*.js` and asserts each
   one is declared in that package's `dependencies`. This is what catches finding 10, and it
   catches the next one automatically. The current one-line reproduction:

   ```sh
   grep -ho 'from "[^".][^"]*"' packages/core/dist/*.js | sed 's/from "//; s/"$//' \
     | grep -v '^node:' | sort -u
   ```

6. Re-run `bun pm pack` and record the new size in the commit message.

Acceptance: the tarball drops from 11.67MB to under 1MB plus the client bundle. No chunk in
`packages/core/dist` mentions `node_modules/.bun/twilio`, `@slack`, `@linear`, `@clerk`, or
`resend`. The import test passes, and `axios` has left `@wfgraph/core` entirely, since it belongs
to Twilio and Twilio now lives in `@wfgraph/plugins` (finding 10).

Commit: `Ship the integration plugins as a package, not a bundle`

### Phase 5 -- Call the vendor APIs with fetch

Addresses finding 10 at its root and removes most of what is left of the tarball.

No code in this repo imports `axios`. The `twilio` SDK does, which is the only reason it
appears in the bundle at all. The general point: each built-in plugin pulls a full vendor
SDK to make one or two HTTP calls, and Node has had `fetch` since 18.

| SDK              | Call sites                                                                            | Decision                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `twilio`         | `plugins/src/twilio/steps/send-sms.ts:148`, `twilio/test.ts:20`                       | Replace. One POST to `/2010-04-01/Accounts/{sid}/Messages.json` with basic auth. Drags axios, dayjs, and jsonwebtoken behind it. |
| `resend`         | `plugins/src/resend/steps/send-email.ts:3`, `resend/test.ts:1`                        | Replace. One POST to `/emails`.                                                                                                  |
| `@slack/web-api` | `plugins/src/slack/steps/send-slack-message.ts:1`, `slack/test.ts:1`                  | Replace. `chat.postMessage` plus a small map of the `ErrorCode` values actually branched on.                                     |
| `@linear/sdk`    | `plugins/src/linear/steps/create-ticket.ts:1`, `find-issues.ts:1`, `linear/test.ts:1` | Keep. A typed GraphQL client, and hand-writing those queries trades one dependency for a pile of query strings.                  |
| `@clerk/backend` | `plugins/src/clerk/client.ts:1`                                                       | Keep. It performs JWT verification, which is cryptographic protocol logic worth borrowing rather than reimplementing.            |

1. Rewrite the three replaceable steps and their connection tests against `fetch`. Each
   vendor's error body becomes a `StepResult` failure through the existing contract, so the
   step signatures do not change.
2. Drop `twilio`, `resend`, and `@slack/web-api` from `packages/plugins/package.json`.
   `axios` leaves the tree with twilio.
3. Read each vendor's current API reference with Context7 or Exa before writing the call.
   Do not take an endpoint shape or an auth header from memory.

Acceptance: the import test from Phase 4 shows no `axios`. `@wfgraph/plugins` declares two SDK
dependencies rather than five. Every existing plugin test passes unchanged, which is the
signal that the step contract held.

Commit: one per vendor, `Send SMS through the Twilio REST API` and so on.

### Phase 6 -- An authorization seam

Addresses finding 7.

1. Add `auth: ((request: Request) => boolean | Promise<boolean>) | "external"` to
   `WfGraphAppOptions`. The hook authorizes; it does not identify. No table carries a tenant or
   user column and no service reads an identity, so a `Principal` type that Workflow Graph defines and
   never interprets would be pure interface weight. Widen the return type when Phase 6 or an
   audit column creates the first real consumer of identity; the no-backwards-compatibility
   rule makes that widening cheap.
2. Wire it as middleware ahead of the RPC, REST, extensions, and execute mounts. Leave the
   Inngest callback and the signed webhook path on their existing checks, since those callers
   are machines carrying their own credentials. This split is the reason the hook belongs to
   Workflow Graph rather than to the host: the host supplies the predicate, Workflow Graph supplies the knowledge
   of which routes are human-facing. A host wrapping the whole mount in session middleware
   breaks Inngest and webhooks, and the route taxonomy that would let them wrap correctly is
   exactly the knowledge information hiding says stays inside the module.
3. Refuse to start when `auth` is unset and `NODE_ENV` is production, with an error naming
   the option. The `"external"` token is the escape hatch for a host that gates upstream and
   is saying so deliberately. The library forces a decision rather than a mechanism, so the
   error defined out of existence is the silent one: an editor accidentally reachable from
   the internet, running registered actions with credentials from the encrypted `integrations`
   table.

Rejected: extending `validateApiKey` (`workflow-webhook.workflows.ts:80`) to cover the editor.
It is a machine-credential check, and stretching it into a browser-session mechanism is a
special-general mixture that would force the host's humans to carry a second credential
beside the host's own sessions.

Commit: `Let the host authorize requests to the embedded app`

### Phase 7 -- Host-defined integrations

Addresses finding 6. This is the largest phase and the most valuable for the stated goal.

1. Replace the closed `IntegrationType` union with a branded string plus a registry that
   accepts host-supplied definitions. `isIntegrationType` becomes a registry lookup.
2. Add `createIntegration` to the public entry beside `createAction` and `createTrigger`,
   taking a type, a label, a credential schema, and the fields the editor should render.
3. Extend `/api/extensions` and `client/lib/runtime-extensions.ts` to carry integration
   definitions the same way they already carry actions, so a host integration appears in the
   credential UI with no client rebuild. Follow the existing wire-schema pattern exactly;
   it is the best-designed part of the codebase.
4. Give `createAction`'s execute context typed access to the resolved credentials of the
   integration its node selected, through `credential-fetcher.ts`. Without this, a host
   action still has to manage its own secrets and the integration is decorative.
5. Keep the encrypted-config path unchanged. Host integrations store credentials the same
   way the built-ins do.

Commit: `Let the host define its own integrations`

### Phase 8 -- Cleanups that stop future drift

Addresses findings 8 and 9.

1. Collapse the two `registerRuntimeAction` functions. One store, one name. The browser and
   the server should differ in what they put in it, not in which module they call.
2. State the one-instance-per-process contract in the `createWfGraphApp` interface docs and
   enforce it at the door. A second call differing in database URL, encryption key, or
   Inngest client id fails with one error naming the constraint, raised from `createWfGraphApp`
   itself rather than from whichever `configure*` call happens to notice first.
   `createDatabaseSurface` (`db/index.ts:130`) already throws on any second surface;
   extend the same check to the others and surface it in one place. Make `dispose` genuinely
   release registrations so sequential instances in one test process keep working.

   Threading an instance handle through `db`, `inngest`, and the registries is roughly a
   week and buys nothing yet: two instances in one process means two tenants, and no table
   carries a tenant column, so the data model is single-tenant until the schema grows one.
   The registries are also read by the browser bundle, where module-level state is the right
   design, so threading a handle would either fork their shape or push a context object into
   the React tree. Relaxing this restriction later is invisible to every existing caller,
   which keeps that road open at zero interface cost.

   The current behavior is the bug worth naming: a second `createWfGraphApp` with a different
   URL silently aliases the first connection, and the damage surfaces later as data in the
   wrong database.

Commit: `Register a runtime action through one registry` and `Refuse a second Workflow Graph instance in one process`

## Sequencing notes

- Phases 1 through 3 are one arc and should land together if possible. Phase 3 depends on
  Phase 1, since consolidating onto `createWfGraphApp` is only worth doing once that function
  is the real interface.
- Phase 4 is independent and can be done at any point.
- Phase 5 is independent of everything and can be done by someone else in parallel, since it
  touches only `packages/plugins`. It pairs naturally with Phase 4, which moves those SDKs
  out of the core bundle: together they take the tarball from 11.67MB to roughly the client
  bundle plus a few hundred kilobytes.
- Phase 7 depends on Phase 4, because host integrations and bundled built-ins pulling from
  the same closed registry is what makes the union hard to open.
- Phase 6 is independent, and is the one to pull forward if anyone outside this repo is
  about to mount the app.

## What "done" looks like

A new adopter on Express writes:

```ts
import { createAction } from "@wfgraph/core";
import { createWfGraphApp } from "@wfgraph/core/app";
import { createRequestListener } from "@wfgraph/core/node";
import "@wfgraph/core/plugins";

const wfgraph = await createWfGraphApp({
  basePath: "/workflows",
  database: { url: process.env.DATABASE_URL },
  encryption: { key: process.env.ENCRYPTION_KEY },
  inngest: { client: { id: "my-app" } },
  auth: (request) => mySessionFromCookie(request),
  actions: [cancelAppointment],
  triggers: [appointmentLifecycle],
});

app.use("/workflows", createRequestListener(wfgraph));
```

and their own Inngest events reach their own actions, with the editor rendering forms
derived from their Zod schemas.
