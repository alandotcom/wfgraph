# wfgraph skill spec

Workflow Graph is a self-hosted workflow engine and visual editor that a host
application embeds. It is published as three npm packages that share one version:
`@wfgraph/core` (the engine, the authoring vocabulary and `createWfGraphApp`),
`@wfgraph/client` (the built editor) and `@wfgraph/plugins` (six built-in
integrations). The published skills ship inside the `@wfgraph/core` and
`@wfgraph/plugins` tarballs and target version 3.1.1.

## Maintainer decisions

1. **Audience.** The published skills are for adopters: developers who install
   `@wfgraph/core`, `@wfgraph/client` and `@wfgraph/plugins` in their own
   application. Guidance for contributors to this monorepo stays in `AGENTS.md`
   and `.claude/skills/`, which Intent does not manage.
2. **`@wfgraph/client` has no skill.** An adopter's only task with that package is
   passing its `clientBundle` export to `createWfGraphApp` as `client`, and the
   wfgraph-core skill covers that task. `domain_map.yaml` records the exclusion
   under `coverage.ignored_packages`, the form the `intent stale` documentation
   (tanstack.com/intent, "intent stale", Coverage) gives for an intentionally
   uncovered public workspace package.
3. **Domains.** `embedding` owns wfgraph-core and the three planned sub-skills
   (auth, observability, cloudflare-worker). `host-extensions` owns events and
   host-actions. `integrations` owns integrations and wfgraph-plugins. These
   replace the `uncategorized` and `wfgraph-core` domains that
   `intent maintainer setup` assigned.
4. **Three planned sub-skills of wfgraph-core** are approved for the next commit:
   - `auth` (`packages/core/skills/wfgraph-core/auth/SKILL.md`): the host access
     policy with `defineWfGraphAuth`, `WfGraphRoles`, `WfGraphAccess` and
     `trustWfGraphUpstream`. Source: `docs/embedding.md` "Authentication and
     authorization".
   - `observability` (`packages/core/skills/wfgraph-core/observability/SKILL.md`):
     logging with `configureWfGraphLogging`, the `logger` option and the LogTape
     category `wfgraph`, and tracing with an OpenTelemetry provider, Sentry and
     the stable span names. Source: `docs/embedding.md` "Logging" and "Tracing".
   - `cloudflare-worker`
     (`packages/core/skills/wfgraph-core/cloudflare-worker/SKILL.md`): deploying
     with `wfWorker`, the Cron Trigger, the wake Queue, Hyperdrive with query
     caching off, out-of-band migrations and the platform limits. Source:
     `docs/embedding.md` "Cloudflare Workers and Hyperdrive" and "PostgreSQL
     migrations". The Worker bullets and the two Worker failure modes in
     wfgraph-core move to this skill.
5. **Executable task checks** for skills will live in the private package
   `packages/evals`, in a new `src/skills/` directory, and run in the root
   Vitest `node` project. This record's first batch writes no checks because it
   changes no recommended behavior.
6. **Skills point to the host manuals for copy-paste forms.** `AGENTS.md` places
   copy-paste examples in `README.md`, `docs/embedding.md`, `docs/events.md` and
   `docs/integrations.md`, and forbids pasting them into a skill. A skill holds
   load routing, invariants and common mistakes, and names the manual section
   that holds the example. This rule overrides Intent's skill-format guidance
   that a Setup section carries a complete example with imports. The short
   wrong and correct forms in each skill's Common Mistakes section remain,
   because they show a mistake rather than a setup.
7. **Skill reviews ignore changesets.** `skill_tree.yaml` lists `.changeset/**`
   under `review.ignore`. A changeset is the release note for a change and holds
   no guidance a skill teaches, so `intent maintainer review` no longer reports
   one as an unmapped change that needs its own `out-of-scope` outcome. The
   change the changeset describes is still reviewed through the source paths
   the skills list.
8. **Two more sub-skills of wfgraph-core: `mcp` and `build-agent`.** The batch
   that followed the 126-commit integration branch added both
   (`packages/core/skills/wfgraph-core/mcp/SKILL.md` and
   `packages/core/skills/wfgraph-core/build-agent/SKILL.md`). Connecting an MCP
   client to a deployed host and turning on the editor's chat agent each
   became a task a developer looks for on its own: the MCP endpoint gained
   `mcp.authorization`, 2025-era protocol revisions, publish and restore tools
   and per-tool grants, and the agent gained four providers, a host runner,
   `streamAgentTurn` and a turn limit. wfgraph-core keeps one routing line for
   each option. Its MCP bullets, its Group-preservation bullet for MCP writes
   and its "Repeat a stale MCP write" failure mode moved to `mcp`, the way the
   Worker guidance moved to cloudflare-worker in batch 4. This resolves the
   open question about adopter guidance for the build agent.

## Domains

| Domain          | Description                                                                                                                                                                  | Skills                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| embedding       | Mounting Workflow Graph in a host and operating it: the app call, editor bundle, access policy, persistence, worker loop, Worker, logs, the MCP endpoint and the build agent | wfgraph-core, auth, observability, cloudflare-worker, mcp, build-agent |
| host-extensions | What a host contributes from its own code: Events, Entities and their intake, and host actions                                                                               | events, host-actions                                                   |
| integrations    | Writing a vendor integration against `@wfgraph/core/plugin`, and turning on the six built-ins                                                                                | integrations, wfgraph-plugins                                          |

## Skill Inventory

| Skill             | Type      | Domain          | Status      | What it covers                                                                                                                                                                                     | Failure modes |
| ----------------- | --------- | --------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| wfgraph-core      | core      | embedding       | implemented | `createWfGraphApp`, `createRequestListener`, `clientBundle`, `basePath`, `publicUrl`, the `auth` option, `health`, persistence, migrations, the worker loop, shared runner options                 | 9             |
| events            | sub-skill | host-extensions | implemented | `defineEvent`, `defineEntity`, `correlationPath`, umbrella sources, intake through a typed `events.send`, HTTP, `events.inboxInsert` and Inngest, delivery settlement                              | 7             |
| host-actions      | sub-skill | host-extensions | implemented | `defineAction`, config forms, `options` callbacks, the once-per-node handler, `step.run`, idempotency keys, `runMode`, `readCredentials`, `sideEffect`, `runHostAction`                            | 6             |
| integrations      | sub-skill | integrations    | implemented | `defineIntegration`, `callExternal`, step names and keys, `runMode`, `url` credentials, webhooks, `IntegrationOAuth` with `revoke`, `runAction`, `checkIntegration`, evolving and retiring actions | 8             |
| wfgraph-plugins   | core      | integrations    | implemented | `builtInIntegrations`, `slack(options?)`, the five value exports, OAuth host requirements, `oauthRevocation`, per-step test settings, Resend webhook Events                                        | 4             |
| auth              | sub-skill | embedding       | implemented | the `auth` function and `{ authenticate }`, `defineWfGraphAuth`, `WfGraphRoles`, `WfGraphAccess`, `trustWfGraphUpstream`, the 401, 403, 413 and 500 answers, the editor's grant snapshot           | 5             |
| observability     | sub-skill | embedding       | implemented | `configureWfGraphLogging`, `logger`, LogTape, OpenTelemetry, Sentry, span names, record groups                                                                                                     | 4             |
| cloudflare-worker | sub-skill | embedding       | implemented | `wfWorker`, `wfHyperdrive`, Cron Trigger, wake Queue, Hyperdrive caching and `search_path`, platform limits, tick records                                                                          | 5             |
| mcp               | sub-skill | embedding       | implemented | the `mcp` option, Host and Origin allowlists, bearer tokens in `auth`, `mcp.authorization`, protocol revisions, per-tool grants, the draft-revision protocol                                       | 7             |
| build-agent       | sub-skill | embedding       | implemented | `agent.provider` and its fields, the default model, `agent.runner`, `streamAgentTurn`, `agent.maxConcurrentTurns`, the per-tool grants a turn checks                                               | 4             |

## Failure Mode Inventory

Each failure mode comes from the Common Mistakes section of the skill that owns it.

### wfgraph-core (9 failure modes)

| #   | Mistake                                     | Priority | Source                                              | Cross-skill? |
| --- | ------------------------------------------- | -------- | --------------------------------------------------- | ------------ |
| 1   | Missing authorization boundary              | CRITICAL | docs/embedding.md (createWfGraphApp options)        | auth         |
| 2   | Pass an inngest option to createWfGraphApp  | HIGH     | docs/events.md (Sending through Inngest)            | events       |
| 3   | Body parser in front of the listener        | HIGH     | docs/embedding.md (Mounting on Node)                | none         |
| 4   | Mount path disagrees with basePath          | HIGH     | docs/embedding.md (Mounting on Node)                | none         |
| 5   | Mix url and discrete postgres fields        | HIGH     | docs/embedding.md (Persistence)                     | none         |
| 6   | Apply the shipped migration SQL with psql   | HIGH     | docs/embedding.md (PostgreSQL migrations)           | none         |
| 7   | No process runs the worker loop             | CRITICAL | docs/embedding.md (Workflow runs)                   | none         |
| 8   | Upgrade with legacy Group config keys       | HIGH     | docs/embedding.md (Groups)                          | none         |
| 9   | Separate options for the app and the runner | HIGH     | docs/embedding.md (Run the loop in its own process) | none         |

"Repeat a stale MCP write" moved to mcp under decision 8.

### auth (5 failure modes)

| #   | Mistake                                           | Priority | Source                                               | Cross-skill?                       |
| --- | ------------------------------------------------- | -------- | ---------------------------------------------------- | ---------------------------------- |
| 1   | A policy that grants everything                   | CRITICAL | docs/embedding.md (Authentication and authorization) | wfgraph-core                       |
| 2   | Throwing for a missing session                    | HIGH     | docs/embedding.md (Authentication and authorization) | none                               |
| 3   | A grant-store query inside allows                 | HIGH     | docs/embedding.md (Authentication and authorization) | none                               |
| 4   | Header-only authentication                        | MEDIUM   | docs/embedding.md (Built-in integrations)            | wfgraph-plugins, wfgraph-core, mcp |
| 5   | The host's own page writes from another subdomain | MEDIUM   | docs/embedding.md (Authentication and authorization) | none                               |

### cloudflare-worker (5 failure modes)

| #   | Mistake                                | Priority | Source                                              | Cross-skill? |
| --- | -------------------------------------- | -------- | --------------------------------------------------- | ------------ |
| 1   | A Worker with no Cron Trigger          | CRITICAL | docs/embedding.md (Wake runs through a Queue)       | none         |
| 2   | Hyperdrive with query caching          | HIGH     | docs/embedding.md (Hyperdrive)                      | none         |
| 3   | An origin role without the search_path | HIGH     | docs/embedding.md (Hyperdrive)                      | none         |
| 4   | A runner beside the Worker             | HIGH     | docs/embedding.md (Run the loop in its own process) | wfgraph-core |
| 5   | The Queue's default batch timeout      | MEDIUM   | docs/embedding.md (Wake runs through a Queue)       | none         |

### observability (4 failure modes)

| #   | Mistake                                      | Priority | Source                      | Cross-skill? |
| --- | -------------------------------------------- | -------- | --------------------------- | ------------ |
| 1   | A LogTape configuration with no wfgraph sink | HIGH     | docs/embedding.md (Logging) | none         |
| 2   | A second LogTape configuration               | HIGH     | docs/embedding.md (Logging) | none         |
| 3   | A tracer provider that is never registered   | HIGH     | docs/embedding.md (Tracing) | none         |
| 4   | One trace per run                            | MEDIUM   | docs/embedding.md (Tracing) | none         |

### events (7 failure modes)

| #   | Mistake                                                | Priority | Source                                | Cross-skill? |
| --- | ------------------------------------------------------ | -------- | ------------------------------------- | ------------ |
| 1   | Persist or expose full resolved Entity State           | CRITICAL | docs/events.md (Current Entity State) | none         |
| 2   | Register Entity definitions separately                 | HIGH     | docs/events.md (Current Entity State) | none         |
| 3   | One Event with a subtype field for two lifecycle roles | HIGH     | docs/events.md                        | none         |
| 4   | Transform the payload at intake                        | HIGH     | docs/events.md (The intake gate)      | none         |
| 5   | A when filter standing in for one workflow's rule      | HIGH     | docs/events.md (The umbrella source)  | none         |
| 6   | A hand-written inbox insert on the default search_path | MEDIUM   | docs/events.md (Sending an Event)     | none         |
| 7   | Schema library without JSON Schema                     | MEDIUM   | docs/events.md                        | none         |

### host-actions (6 failure modes)

| #   | Mistake                             | Priority | Source                                                                   | Cross-skill? |
| --- | ----------------------------------- | -------- | ------------------------------------------------------------------------ | ------------ |
| 1   | Effect handler on defineAction      | HIGH     | docs/integrations.md (Effect for integrations, Promise for host actions) | integrations |
| 2   | Catch around readCredentials        | HIGH     | docs/integrations.md                                                     | none         |
| 3   | Redundant or missing field title    | MEDIUM   | docs/embedding.md                                                        | none         |
| 4   | A side effect with no runMode check | CRITICAL | docs/embedding.md (Test runs call your handler)                          | mcp          |
| 5   | Two external calls in one step      | HIGH     | docs/embedding.md (A handler runs once per node of a run)                | none         |
| 6   | A key the vendor never sees         | HIGH     | docs/embedding.md (A handler runs once per node of a run)                | none         |

### integrations (8 failure modes)

| #   | Mistake                                           | Priority | Source                                                                   | Cross-skill?    |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------ | --------------- |
| 1   | Register on import                                | CRITICAL | docs/integrations.md                                                     | wfgraph-plugins |
| 2   | HTTP call outside step.run                        | CRITICAL | docs/integrations.md (What is remembered across a replay)                | none            |
| 3   | Retry refresh or set safeToRepeat on a token POST | CRITICAL | docs/integrations.md (Core owns the browser flow)                        | none            |
| 4   | Lift the handler out of the actions record        | HIGH     | docs/integrations.md (The definition)                                    | none            |
| 5   | Promise handler inside defineIntegration          | HIGH     | docs/integrations.md (Effect for integrations, Promise for host actions) | host-actions    |
| 6   | Remove a config key on a live action id           | HIGH     | docs/integrations.md (Evolving an action)                                | none            |
| 7   | Pass decoded handler input to runAction           | HIGH     | docs/integrations.md (Testing an integration)                            | none            |
| 8   | A revoke that throws for an already revoked token | HIGH     | docs/integrations.md (Core owns the browser flow)                        | none            |

### mcp (7 failure modes)

| #   | Mistake                                              | Priority | Source                                          | Cross-skill? |
| --- | ---------------------------------------------------- | -------- | ----------------------------------------------- | ------------ |
| 1   | A bearer token nobody verifies                       | CRITICAL | docs/embedding.md (MCP authoring)               | auth         |
| 2   | An auth function that reads only the editor's cookie | HIGH     | docs/embedding.md (MCP authoring)               | auth         |
| 3   | mcp true on a deployed host                          | HIGH     | docs/embedding.md (MCP authoring)               | none         |
| 4   | Repeat a stale MCP write                             | HIGH     | docs/embedding.md (MCP authoring)               | none         |
| 5   | Retry create_workflow after an unknown result        | HIGH     | docs/embedding.md (MCP authoring)               | none         |
| 6   | Publish on canSave                                   | MEDIUM   | docs/embedding.md (MCP authoring)               | none         |
| 7   | start_test_run treated as a dry run                  | MEDIUM   | docs/embedding.md (Test runs call your handler) | host-actions |

### build-agent (4 failure modes)

| #   | Mistake                                               | Priority | Source                                                     | Cross-skill? |
| --- | ----------------------------------------------------- | -------- | ---------------------------------------------------------- | ------------ |
| 1   | Anthropic or OpenRouter with no model                 | HIGH     | docs/embedding.md (The build agent)                        | none         |
| 2   | A Chat Completions gateway under the default provider | HIGH     | docs/embedding.md (The build agent)                        | none         |
| 3   | An unset variable read as a startup check             | MEDIUM   | docs/embedding.md (The build agent)                        | none         |
| 4   | A runner that draws the canvas itself                 | MEDIUM   | docs/embedding.md (Run turns on your own gateway or model) | none         |

### wfgraph-plugins (4 failure modes)

| #   | Mistake                                 | Priority | Source                                    | Cross-skill?       |
| --- | --------------------------------------- | -------- | ----------------------------------------- | ------------------ |
| 1   | Expect import to enable integrations    | CRITICAL | packages/plugins/README.md                | integrations       |
| 2   | Slack OAuth without publicUrl           | HIGH     | docs/embedding.md (Built-in integrations) | none               |
| 3   | Two copies of @wfgraph/core             | HIGH     | docs/embedding.md                         | none               |
| 4   | Header-based auth on the OAuth callback | MEDIUM   | docs/embedding.md                         | wfgraph-core, auth |

## Tensions

| Tension                                               | Skills                                | Agent implication                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Promise host step versus Effect integration           | host-actions ↔ integrations           | An agent that loads one skill writes the other path's handler, credential read or failure form.                                          |
| In-process loop versus a separate runner or a Worker  | wfgraph-core ↔ cloudflare-worker      | An agent applies runner options to a Worker, or turns the loop off in every process.                                                     |
| OAuth callback behind host auth                       | wfgraph-plugins ↔ wfgraph-core ↔ auth | An agent writes header-only authentication, and every OAuth connection fails at the callback.                                            |
| Cookie for the editor, bearer token for an MCP client | auth ↔ mcp                            | An agent writes `auth` for one caller, so the other's every request answers `401`, or accepts any bearer header to make the client work. |

## Cross-References

| From            | To                | Reason                                                                                                                |
| --------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| events          | wfgraph-core      | The worker loop delivers every Event, and `events.retentionMs` is also the deduplication window.                      |
| host-actions    | integrations      | The Promise and Effect comparison decides which path a step belongs on.                                               |
| integrations    | wfgraph-plugins   | The six built-ins are the worked examples, and a host turns them on the way it turns on its own.                      |
| wfgraph-plugins | wfgraph-core      | OAuth and webhook URLs depend on `publicUrl`, `basePath` and the `auth` callback.                                     |
| wfgraph-core    | auth              | `auth` is a required option; the auth skill owns the policy guidance.                                                 |
| wfgraph-core    | observability     | Start-up warns when no logging is configured; wfgraph-core keeps the console setup and observability owns the rest.   |
| wfgraph-core    | cloudflare-worker | wfgraph-core keeps one routing line for `wfWorker`; the deployment and its failure modes live in cloudflare-worker.   |
| wfgraph-core    | mcp               | wfgraph-core keeps one routing line for `mcp`; the endpoint's security, grants and protocol live in mcp.              |
| wfgraph-core    | build-agent       | wfgraph-core keeps one routing line for `agent`; providers, the runner and grants live in build-agent.                |
| mcp             | host-actions      | `start_test_run` calls every handler with `runMode: "test"`, and host-actions owns the rule that a handler checks it. |
| build-agent     | mcp               | A build agent turn checks the same per-tool grants as the MCP endpoint.                                               |

## Subsystems & Reference Candidates

| Skill        | Subsystems                                                                  | Reference candidates                                                   |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| wfgraph-core | PostgreSQL (`wfPostgres`), SQLite (`wfSqlite`), Hyperdrive (`wfHyperdrive`) | None. Decision 6 makes the host manuals the reference for dense forms. |
| others       | none                                                                        | none                                                                   |

## Remaining Gaps

| Skill             | Question                                                                                                                                                                                                                                           | Status   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| wfgraph-core      | Does configuring the build agent (`agent.apiKey`, `agent.model`, `agent.reasoningEffort`, `agent.baseUrl`) need adopter guidance? Resolved by decision 8: the build-agent skill covers it.                                                         | resolved |
| all               | Discovery checks have not run for any skill, and no fresh consumer session has attempted a task. Executable task checks exist for auth, observability, cloudflare-worker, host-actions, mcp and build-agent (`packages/evals/src/skills/`).        | open     |
| build-agent       | Without a live model these claims are unverified: a gateway passing streaming, tools and the cache fields through, adaptive thinking on older Claude models, the `usage` part, and a turn's per-tool grants in a live turn.                        | open     |
| auth              | `docs/embedding.md` ("createWfGraphApp options") says Workflow Graph refuses to start without `auth`. The code starts, and every operator request answers `500`; only the type requires the option. Resolved: the manual now states that behavior. | resolved |
| cloudflare-worker | Without workerd and Hyperdrive, these claims are unverified: query caching, the Wrangler configuration, Node.js compatibility, the wall-time, CPU and statement limits, the tick constants as Cloudflare enforces them, and Queue delivery itself. | open     |
| auth              | The operation table in `docs/embedding.md` ("Authentication and authorization") omits `action.configOptions`, which `WfGraphOperations` grants under `workflow.write`. Resolved: the manual's table now lists it.                                  | resolved |

## Recommended Skill File Structure

- **Core skills:** wfgraph-core (`@wfgraph/core`) and wfgraph-plugins (`@wfgraph/plugins`).
- **Sub-skills:** events, host-actions, integrations, auth, observability,
  cloudflare-worker, mcp and build-agent under
  `packages/core/skills/wfgraph-core/`.
- **Framework skills:** none. The packages are framework-agnostic; `hono` is an
  internal peer dependency, and Node, Express, Fastify and Bun mounting is one
  wfgraph-core task.
- **Lifecycle and composition skills:** none planned. The Inngest forwarders sit
  in events and wfgraph-core, and Sentry and OpenTelemetry sit in
  observability.
- **Reference files:** none (decision 6).

## Composition Opportunities

| Library                        | Integration points                                           | Composition skill needed?                           |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| inngest                        | `createWfGraphInngestFunctions` on the host's Inngest client | No. events and wfgraph-core cover it.               |
| hono                           | Peer dependency of `@wfgraph/core`                           | No. Adopters never call it directly.                |
| LogTape, OpenTelemetry, Sentry | Log sinks and the tracer provider                            | No. The observability skill covers them.            |
| Cloudflare Workers             | `wfWorker`, Cron Trigger, Queue, Hyperdrive                  | No. The cloudflare-worker skill covers it.          |
| Zod, arktype, Effect Schema    | Standard Schema for Events and actions                       | No. events and host-actions cover the schema rules. |

## Coverage and batch history

### Assessed scope

The assessment read every section of `README.md` ("Embed in your app"),
`docs/embedding.md`, `docs/events.md`, `docs/integrations.md` and
`packages/plugins/README.md` at commit 3ba18087, with the packages at 3.1.1.

Coverage of `docs/embedding.md` by section:

- Covered by wfgraph-core: the introduction and install line, "Mounting on
  Node", "The editor" (the `client` option), "Groups" (the removed config keys
  and the rules MCP writes keep), "MCP authoring", "Persistence", "Workflow
  runs" with all five subsections, "PostgreSQL migrations" and "createWfGraphApp
  options". wfgraph-core also keeps the required `auth` option, the one-line
  console logging setup, and one routing line for `wfWorker`.
- Covered by host-actions: "Dynamic host action fields".
- Covered by wfgraph-plugins: "Built-in integrations".
- Covered by auth: "Authentication and authorization", and the OAuth callback
  requirement in "Built-in integrations".
- Covered by observability: "Logging", "Tracing", "Sentry" and "Any other
  backend".
- Covered by cloudflare-worker: "Cloudflare Workers and Hyperdrive" with its
  four subsections, and the Worker use of "PostgreSQL migrations".
- Assessed and left without a skill: "Workspaces and Canvas Reveal" and "On a
  phone" describe the editor for the people who use it and hold no adopter code
  task. "Package exports" is a reference table that each skill's entry points
  already name.
- Open: the build agent options in "createWfGraphApp options" and "API
  endpoints" (the served OpenAPI document). Neither has a maintainer decision.

Not assessed: `CONTEXT.md`, `docs/adr/`, `examples/app.ts`, and the package
sources, apart from the source checks each later batch records.

### Batch 1: record the existing skills (packages at 3.1.1, base 3ba18087)

- Registered the five existing skills under the domains in decision 3 and
  recorded each skill's developer tasks, covered APIs, failure modes, sources,
  tensions and cross-references in `domain_map.yaml`.
- Migrated each skill's frontmatter to Intent's purpose and activation fields.
  The pre-edit `description` text is preserved unchanged as `metadata.purpose`,
  and the new `description` states when to load the skill, includes requests
  that name no API, and names the adjacent skill for the neighboring task. No
  skill body, example or `library_version` changed.
- Recorded the three planned sub-skills in all three documents with
  `status: planned` in `skill_tree.yaml`. The wfgraph-core sub-skill routing
  table does not list them yet. `intent validate` accepts a routing row or link
  to a missing skill, but the published table would then route adopters to a
  skill absent from the tarball, so the rows belong to the commit that adds the
  files.
- Recorded the `@wfgraph/client` exclusion (decision 2).
- Checks: `intent validate` passed for the five skills. Each skill's claims were
  compared with its cited manual sections at this revision; the one claim
  traced to source instead of a manual is listed under Remaining Gaps. No
  executable task check or discovery check ran, because none exists yet
  (decision 5) and this batch changes no recommended behavior. Activation of the
  new descriptions is unverified.
- `intent stale` (0.5.6) reports the three planned tree entries as "artifact
  skill path does not resolve", because it reads `path` without honoring
  `status: planned`. `intent maintainer check` passes. The warnings clear when
  the next commit adds the three files.

### The manual states the Hyperdrive runner refusal

- `docs/embedding.md` ("Run the loop in its own process" and "Cloudflare
  Workers and Hyperdrive") now says that `createWfGraphRunner` refuses
  `wfHyperdrive` at startup. The refusal comes from `resolveRunnerSettings` in
  `packages/core/src/backend/executor/in-process-runner.ts`, which
  `openWfGraphSetup` calls after it opens the backend: Hyperdrive declares no
  loop poll interval, so the call throws "This persistence backend runs no
  long-lived worker loop; its runs advance through the ticks that wfWorker's
  scheduled and queue handlers run". wfgraph-core's claim now traces to its
  cited manual, which closes the gap batch 1 recorded. No skill text changed.

### Batch 2: the auth skill (packages at 3.1.1, base c774d9c7)

- Wrote `packages/core/skills/wfgraph-core/auth/SKILL.md` from
  `docs/embedding.md` ("Authentication and authorization", and the OAuth
  callback rule in "Built-in integrations"), with each claim checked against
  `packages/core/src/backend/lib/http/authorize.ts`,
  `packages/shared/src/authorization/operations.ts`, `packages/core/src/app.ts`
  and `packages/core/src/backend/api-app.ts`. The skill holds the procedure, the
  role table, the meaning of each status code, the routes that skip the
  callback, the grant snapshot and four mistakes. The full operation table
  stays in the manual (decision 6).
- wfgraph-core keeps the required `auth` option as one bullet and its CRITICAL
  mistake, and routes the policy, the grant-loading rule and the OAuth cookie
  rule to auth. Its routing table gained the auth row. Its "Missing
  authorization boundary" mistake no longer says Workflow Graph refuses to start
  without `auth`: a probe showed the app starts and answers `500` to every
  operator request, and only the type requires the option.
- Decision: the auth check grades over HTTP against `createWfGraphApp` on
  in-memory SQLite, with a session cookie as the host's session. It covers the
  role policies, a `fromPermissions` policy built from a host grant store, and
  two incorrect solutions: a policy that grants everything (the grader fails at
  its first assertion, `expected 200 to be 401`) and a store read inside
  `allows` (the boundary holds and the one-read-per-request assertion fails).
- Checks: `intent validate` passed for six skills; `pnpm run test` ran the four
  auth cases in the node project. Discovery and a fresh consumer session are
  unverified (no isolated agent session was available). Not covered by an
  executable check: the OAuth callback cookie rule, the `500` answers for a
  malformed policy or a non-boolean `allows`, and `trustWfGraphUpstream()`.

### Batch 3: the observability skill (packages at 3.1.1, base 807145b5)

- Wrote `packages/core/skills/wfgraph-core/observability/SKILL.md` from
  `docs/embedding.md` ("Logging", "Tracing", "Sentry", "Any other backend"),
  checked against `packages/core/src/logging.ts`,
  `packages/core/src/backend/lib/log-config.ts` (both setups replace any other
  LogTape configuration; the start-up warning),
  `packages/core/src/backend/lib/telemetry.ts` (the `wfgraph-workflows`
  scope), `packages/core/src/backend/api-app.ts` (the `http` record) and
  `packages/core/src/backend/lib/db/migrations.ts` (migrations log under
  `wfgraph`). The skill holds a decision table for the three logging setups,
  keyed on what logging the host already has.
- wfgraph-core keeps the one-line `configureWfGraphLogging()` setup as the
  minimum a host needs, and routes the other setups and tracing to
  observability. Its routing table gained the observability row.
- Decision: `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` moved into
  the pnpm catalog, since core and the evals package now both declare them.
  `@opentelemetry/api` stays on `^1.9.1`: npm's latest is 1.10.0, but
  `@opentelemetry/sdk-trace-base` 2.12.0 (its latest) peers on
  `>=1.3.0 <1.10.0`, and the workspace override already holds the API to the
  1.9 line. The evals package also declares `@logtape/logtape` from the catalog.
- Checks: `packages/evals/src/skills/observability/tracing.test.ts` registers
  an in-memory provider on the global API, runs a published workflow, and
  asserts the `wfgraph.workflow.execution` span with its four attributes and
  the node span under `wfgraph-workflows`, for a provider registered before
  and after `createWfGraphApp`. The incorrect solution, a provider never
  registered, fails the grader at "no wfgraph.workflow.execution span for the
  run". `logging.test.ts` configures LogTape the way a host with its own
  logging does and asserts that the start-up record, the `wfgraph.http` record
  with its `http` group, and the host's own record all arrive. Two incorrect
  solutions fail it: no `wfgraph` logger entry (no start-up record), and the
  `logger` option on top of the host's configuration (the host's record never
  arrives).
- Unverified: `configureWfGraphLogging` output and its environment variables,
  the Sentry and `@logtape/sentry` setup (neither package is installed here),
  the twelve service span names, and the one-trace-per-pass claim. Discovery
  and a fresh consumer session are unverified.

### Batch 4: the cloudflare-worker skill (packages at 3.1.1, base 48c5c11c)

- Wrote `packages/core/skills/wfgraph-core/cloudflare-worker/SKILL.md` from
  `docs/embedding.md` ("Cloudflare Workers and Hyperdrive" with its four
  subsections, "PostgreSQL migrations", and the runner refusal in "Run the loop
  in its own process"), checked against `packages/core/src/backend/worker.ts`
  (the tick budget, claim window, lease, heartbeat and pass limit constants,
  the Cron-only sweeps, the tick records and span, the rethrow) and
  `packages/core/src/backend/persistence/hyperdrive-postgres.ts` (the
  `current_schema()` refusal). It adds three mistakes the manual implies: an
  origin role without the `search_path`, a runner beside the Worker, and the
  Queue's default batch timeout.
- Moved out of wfgraph-core: the three Cloudflare Workers bullets under
  Persistence and the "A Worker with no Cron Trigger" and "Hyperdrive with
  query caching" mistakes. wfgraph-core keeps one routing line and a routing
  table row, and its description routes auth, observability and Worker
  deployments to their skills.
- Decision: the Node checks stand a SQLite file in for Hyperdrive, as
  `packages/core/src/backend/worker.test.ts` does, because a tick's claims and
  parks are the same repository contract on both backends. A small platform
  stand-in delivers pending Queue messages and fires the Cron Trigger only
  when the deployment configures each.
- Checks: `worker-entry.ts` is the documented entry against
  `@wfgraph/core/worker` and type-checks under `pnpm run type-check`.
  `worker.test.ts` loads it, checks that `wfWorker` has no `runner` option (a
  `@ts-expect-error` that type-check enforces), that a `publicUrl` with a path
  throws when the Worker starts, and that a bad encryption key or a blank
  events key fail an invocation before persistence opens. Its grader posts an
  Event that starts a run with a one-second Wait and asserts the run completes
  after two platform minutes: a Cron Trigger with or without a Queue passes,
  a Queue alone fails with the run still `waiting`, and neither fails with no
  run. `hyperdrive.pg.test.ts` runs in the `postgres` project against a live
  server: the Worker opens Hyperdrive when the factory's `schema` is the origin
  role's first schema, the documented entry is refused against a role whose
  `search_path` was never set, and `createWfGraphRunner` refuses
  `wfHyperdrive`. It passed against the `docker compose` server and skips
  without `WFGRAPH_TEST_DATABASE_URL`.
- Unverified: see Remaining Gaps. Discovery and a fresh consumer session are
  unverified.

### Batch 5: the integration branch's contract changes (packages at 3.1.1, base 270446ee, head 777cdf25)

- Source: the 107 changesets under `.changeset/`, `git log 270446ee..777cdf25`
  (126 commits), and the code and host manuals at 777cdf25. The packages are
  still versioned 3.1.1 because the release has not been cut, so no
  `library_version` moved.
- Manual drift fixed in `docs/embedding.md`: "MCP authoring" now describes
  how the `auth` function handles an MCP client's bearer token, the 401
  challenge, `mcp.authorization` with its RFC 9728 metadata route, and the
  `canSave` and `canPublish` fields of `validate_workflow`. "Workflow runs"
  now says how a delivery that fails for some workflows settles its inbox row
  and what a paused workflow still receives. `README.md`, `docs/events.md` and
  `docs/integrations.md` already matched the code for every change this batch
  checked.
- wfgraph-core: the return shape names `health`. `auth` takes a function or
  `{ authenticate }` and is refused at startup when missing or malformed, so
  the CRITICAL mistake no longer claims a missing `auth` answers `500`.
  `encryption` is optional with no integration. Added `health: true` and
  `app.health()`, the PostgreSQL concurrency default, `maxStepValueBytes`, the
  shared options object for `createWfGraphRunner` with a new HIGH mistake, and
  the drain of a plain Promise step. The MCP bullets and mistake moved to mcp.
- auth: the function form, `undefined` as a `401`, the cross-site write `403`
  and the `413` body cap, the health and MCP metadata routes outside the
  callback, and a new MEDIUM mistake for writes from a sibling subdomain.
- host-actions: the handler runs once per node of a run, `step.run` marks
  resumable parts, idempotency keys, and test runs calling the handler with
  `runMode: "test"`. The `sideEffect` text no longer says the run dialog counts
  host actions, which the manual says it does not. `runHostAction` with `memo`
  and `handlerRan`. Three new mistakes.
- integrations: step names and their node scope, `step.idempotencyKey`, the
  step value limit, `runMode`, `url` credential fields, `revoke` on delete, and
  the `runMode` and run id of `runAction`. One new mistake.
- events: the typed `events.send`, `events.inboxInsert`, per-workflow delivery
  retries and the `failed` settlement, resends keeping refusals, and paused
  workflows. One new mistake.
- observability: `app.health().queue` as a metric, credential masking in
  refused RPC records, and the `trace` record of a readiness probe.
- cloudflare-worker: a cut pass on a plain Promise step is released one lease
  later, and `encryption.key` stays required on a Worker.
- wfgraph-plugins: `oauthRevocation` on delete, Slack's already-uninstalled
  answers, per-step test settings, the PostHog `https:` host rule, and the
  per-node idempotency key of Resend's Send Email.
- New skills under decision 8: mcp and build-agent.
- Left out on purpose: the publish warning, a Wait that wakes on an Event
  delivered before it parked, and out-of-order Cancel handling, which another
  workstream on this branch is still changing.
- Checks: `intent validate` passed for ten skills. New task checks in
  `packages/evals/src/skills/`. `host-actions/refund-action.test.ts` grades a
  refund action with `runHostAction` and rejects a handler that ignores
  `runMode` (`expected [ { id: 'ch_1', …(1) } ] to have a length of +0 but got
  1`) and one that puts both calls in one step, which hands both calls one key.
  `mcp/mcp-endpoint.test.ts` grades the endpoint over HTTP at revision
  `2026-07-28` and rejects a cookie-only `auth` (`expected 401 to be 200`), an
  `auth` that accepts any bearer token (`expected 200 to be 401`) and
  `mcp: true` on a deployed hostname (`expected 403 to be 200`).
  `build-agent/agent-config.test.ts` grades `agent.enabled` and the startup
  refusals for each provider form and a runner. `packages/evals/src/skills/host.ts`
  now lets a check pass `mcp` and `agent`. Discovery and a fresh consumer
  session are unverified, as for every earlier batch.

### Remaining work

1. Add discovery prompts for every skill, and executable task checks for
   wfgraph-core, events, integrations and wfgraph-plugins.
2. Resolve the open gaps.
