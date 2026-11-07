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

## Domains

| Domain          | Description                                                                                                                            | Skills                                                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| embedding       | Mounting Workflow Graph in a host and operating it: the app call, editor bundle, access policy, persistence, worker loop, Worker, logs | wfgraph-core; planned: auth, observability, cloudflare-worker |
| host-extensions | What a host contributes from its own code: Events, Entities and their intake, and host actions                                         | events, host-actions                                          |
| integrations    | Writing a vendor integration against `@wfgraph/core/plugin`, and turning on the six built-ins                                          | integrations, wfgraph-plugins                                 |

## Skill Inventory

| Skill             | Type      | Domain          | Status      | What it covers                                                                                                                              | Failure modes |
| ----------------- | --------- | --------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| wfgraph-core      | core      | embedding       | implemented | `createWfGraphApp`, `createRequestListener`, `clientBundle`, `basePath`, `publicUrl`, `auth`, persistence, migrations, the worker loop, MCP | 11            |
| events            | sub-skill | host-extensions | implemented | `defineEvent`, `defineEntity`, `correlationPath`, umbrella sources, intake through `events.send`, HTTP, the inbox table and Inngest         | 6             |
| host-actions      | sub-skill | host-extensions | implemented | `defineAction`, config forms, `options` callbacks, `step.run`, `readCredentials`, `sideEffect`                                              | 3             |
| integrations      | sub-skill | integrations    | implemented | `defineIntegration`, `callExternal`, webhooks, `IntegrationOAuth`, `runAction`, `checkIntegration`, evolving and retiring actions           | 7             |
| wfgraph-plugins   | core      | integrations    | implemented | `builtInIntegrations`, `slack(options?)`, the five value exports, OAuth host requirements, Resend webhook Events                            | 4             |
| auth              | sub-skill | embedding       | planned     | `defineWfGraphAuth`, `WfGraphRoles`, `WfGraphAccess`, `trustWfGraphUpstream`                                                                | not authored  |
| observability     | sub-skill | embedding       | planned     | `configureWfGraphLogging`, `logger`, LogTape, OpenTelemetry, Sentry, span names                                                             | not authored  |
| cloudflare-worker | sub-skill | embedding       | planned     | `wfWorker`, `wfHyperdrive`, Cron Trigger, wake Queue, Hyperdrive caching, platform limits                                                   | not authored  |

## Failure Mode Inventory

Each failure mode comes from the Common Mistakes section of the skill that owns it.

### wfgraph-core (11 failure modes)

| #   | Mistake                                    | Priority | Source                                                | Cross-skill?                |
| --- | ------------------------------------------ | -------- | ----------------------------------------------------- | --------------------------- |
| 1   | Missing authorization boundary             | CRITICAL | docs/embedding.md (createWfGraphApp options)          | auth (planned)              |
| 2   | Pass an inngest option to createWfGraphApp | HIGH     | docs/events.md (Sending through Inngest)              | events                      |
| 3   | Body parser in front of the listener       | HIGH     | docs/embedding.md (Mounting on Node)                  | none                        |
| 4   | Mount path disagrees with basePath         | HIGH     | docs/embedding.md (Mounting on Node)                  | none                        |
| 5   | Mix url and discrete postgres fields       | HIGH     | docs/embedding.md (Persistence)                       | none                        |
| 6   | Apply the shipped migration SQL with psql  | HIGH     | docs/embedding.md (PostgreSQL migrations)             | none                        |
| 7   | No process runs the worker loop            | CRITICAL | docs/embedding.md (Workflow runs)                     | none                        |
| 8   | A Worker with no Cron Trigger              | CRITICAL | docs/embedding.md (Cloudflare Workers and Hyperdrive) | cloudflare-worker (planned) |
| 9   | Hyperdrive with query caching              | HIGH     | docs/embedding.md (Cloudflare Workers and Hyperdrive) | cloudflare-worker (planned) |
| 10  | Upgrade with legacy Group config keys      | HIGH     | docs/embedding.md (Groups)                            | none                        |
| 11  | Repeat a stale MCP write                   | HIGH     | docs/embedding.md (MCP authoring)                     | none                        |

### events (6 failure modes)

| #   | Mistake                                                | Priority | Source                                | Cross-skill? |
| --- | ------------------------------------------------------ | -------- | ------------------------------------- | ------------ |
| 1   | Persist or expose full resolved Entity State           | CRITICAL | docs/events.md (Current Entity State) | none         |
| 2   | Register Entity definitions separately                 | HIGH     | docs/events.md (Current Entity State) | none         |
| 3   | One Event with a subtype field for two lifecycle roles | HIGH     | docs/events.md                        | none         |
| 4   | Transform the payload at intake                        | HIGH     | docs/events.md (The intake gate)      | none         |
| 5   | A when filter standing in for one workflow's rule      | HIGH     | docs/events.md (The umbrella source)  | none         |
| 6   | Schema library without JSON Schema                     | MEDIUM   | docs/events.md                        | none         |

### host-actions (3 failure modes)

| #   | Mistake                          | Priority | Source                                                                   | Cross-skill? |
| --- | -------------------------------- | -------- | ------------------------------------------------------------------------ | ------------ |
| 1   | Effect handler on defineAction   | HIGH     | docs/integrations.md (Effect for integrations, Promise for host actions) | integrations |
| 2   | Catch around readCredentials     | HIGH     | docs/integrations.md                                                     | none         |
| 3   | Redundant or missing field title | MEDIUM   | docs/embedding.md                                                        | none         |

### integrations (7 failure modes)

| #   | Mistake                                           | Priority | Source                                                                   | Cross-skill?    |
| --- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------ | --------------- |
| 1   | Register on import                                | CRITICAL | docs/integrations.md                                                     | wfgraph-plugins |
| 2   | HTTP call outside step.run                        | CRITICAL | docs/integrations.md (What is remembered across a replay)                | none            |
| 3   | Retry refresh or set safeToRepeat on a token POST | CRITICAL | docs/integrations.md (Core owns the browser flow)                        | none            |
| 4   | Lift the handler out of the actions record        | HIGH     | docs/integrations.md (The definition)                                    | none            |
| 5   | Promise handler inside defineIntegration          | HIGH     | docs/integrations.md (Effect for integrations, Promise for host actions) | host-actions    |
| 6   | Remove a config key on a live action id           | HIGH     | docs/integrations.md (Evolving an action)                                | none            |
| 7   | Pass decoded handler input to runAction           | HIGH     | docs/integrations.md (Testing an integration)                            | none            |

### wfgraph-plugins (4 failure modes)

| #   | Mistake                                 | Priority | Source                                    | Cross-skill?                 |
| --- | --------------------------------------- | -------- | ----------------------------------------- | ---------------------------- |
| 1   | Expect import to enable integrations    | CRITICAL | packages/plugins/README.md                | integrations                 |
| 2   | Slack OAuth without publicUrl           | HIGH     | docs/embedding.md (Built-in integrations) | none                         |
| 3   | Two copies of @wfgraph/core             | HIGH     | docs/embedding.md                         | none                         |
| 4   | Header-based auth on the OAuth callback | MEDIUM   | docs/embedding.md                         | wfgraph-core, auth (planned) |

## Tensions

| Tension                                              | Skills                                     | Agent implication                                                                               |
| ---------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Promise host step versus Effect integration          | host-actions ↔ integrations                | An agent that loads one skill writes the other path's handler, credential read or failure form. |
| In-process loop versus a separate runner or a Worker | wfgraph-core ↔ cloudflare-worker (planned) | An agent applies runner options to a Worker, or turns the loop off in every process.            |
| OAuth callback behind host auth                      | wfgraph-plugins ↔ wfgraph-core ↔ auth      | An agent writes header-only authentication, and every OAuth connection fails at the callback.   |

## Cross-References

| From            | To                          | Reason                                                                                            |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| events          | wfgraph-core                | The worker loop delivers every Event, and `events.retentionMs` is also the deduplication window.  |
| host-actions    | integrations                | The Promise and Effect comparison decides which path a step belongs on.                           |
| integrations    | wfgraph-plugins             | The six built-ins are the worked examples, and a host turns them on the way it turns on its own.  |
| wfgraph-plugins | wfgraph-core                | OAuth and webhook URLs depend on `publicUrl`, `basePath` and the `auth` callback.                 |
| wfgraph-core    | auth (planned)              | `auth` is a required option, and the planned skill will own the policy guidance.                  |
| wfgraph-core    | observability (planned)     | Start-up warns when no logging is configured, and the planned skill will own logging and tracing. |
| wfgraph-core    | cloudflare-worker (planned) | The Worker bullets and failure modes in wfgraph-core move to the planned skill.                   |

## Subsystems & Reference Candidates

| Skill        | Subsystems                                                                  | Reference candidates                                                   |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| wfgraph-core | PostgreSQL (`wfPostgres`), SQLite (`wfSqlite`), Hyperdrive (`wfHyperdrive`) | None. Decision 6 makes the host manuals the reference for dense forms. |
| others       | none                                                                        | none                                                                   |

## Remaining Gaps

| Skill        | Question                                                                                                                                                                              | Status |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| wfgraph-core | The claim that `createWfGraphRunner` refuses Hyperdrive rests on `packages/core/src/backend/setup.ts`. `docs/embedding.md` names only the SQLite refusal. Should the manual state it? | open   |
| wfgraph-core | Does configuring the build agent (`agent.apiKey`, `agent.model`, `agent.reasoningEffort`, `agent.baseUrl`) need adopter guidance?                                                     | open   |
| all          | Discovery checks and executable task checks have not run for any skill (decision 5 places them in `packages/evals/src/skills/`).                                                      | open   |

## Recommended Skill File Structure

- **Core skills:** wfgraph-core (`@wfgraph/core`) and wfgraph-plugins (`@wfgraph/plugins`).
- **Sub-skills:** events, host-actions and integrations under
  `packages/core/skills/wfgraph-core/`, and the planned auth, observability and
  cloudflare-worker in the same directory.
- **Framework skills:** none. The packages are framework-agnostic; `hono` is an
  internal peer dependency, and Node, Express, Fastify and Bun mounting is one
  wfgraph-core task.
- **Lifecycle and composition skills:** none planned. The Inngest forwarders sit
  in events and wfgraph-core, and Sentry and OpenTelemetry will sit in
  observability.
- **Reference files:** none (decision 6).

## Composition Opportunities

| Library                        | Integration points                                           | Composition skill needed?                           |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------------------- |
| inngest                        | `createWfGraphInngestFunctions` on the host's Inngest client | No. events and wfgraph-core cover it.               |
| hono                           | Peer dependency of `@wfgraph/core`                           | No. Adopters never call it directly.                |
| LogTape, OpenTelemetry, Sentry | Log sinks and the tracer provider                            | No. The planned observability skill covers them.    |
| Cloudflare Workers             | `wfWorker`, Cron Trigger, Queue, Hyperdrive                  | No. The planned cloudflare-worker skill covers it.  |
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
  options". wfgraph-core also summarizes "Authentication and authorization",
  "Cloudflare Workers and Hyperdrive" and "Logging" in a few bullets each.
- Covered by host-actions: "Dynamic host action fields".
- Covered by wfgraph-plugins: "Built-in integrations".
- Planned: "Authentication and authorization" (auth), "Logging" and "Tracing"
  (observability), "Cloudflare Workers and Hyperdrive" with its four
  subsections and the Worker use of "PostgreSQL migrations" (cloudflare-worker).
- Assessed and left without a skill: "Workspaces and Canvas Reveal" and "On a
  phone" describe the editor for the people who use it and hold no adopter code
  task. "Package exports" is a reference table that each skill's entry points
  already name.
- Open: the build agent options in "createWfGraphApp options" and "API
  endpoints" (the served OpenAPI document). Neither has a maintainer decision.

Not assessed: `CONTEXT.md`, `docs/adr/`, `examples/app.ts`, and the package
sources, apart from one check of `packages/core/src/backend/setup.ts` recorded
under Remaining Gaps.

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

### Remaining work

1. Author auth, observability and cloudflare-worker; move the Worker bullets
   and failure modes from wfgraph-core into cloudflare-worker; add the three
   rows to the wfgraph-core sub-skill table.
2. Create `packages/evals/src/skills/` with discovery prompts and executable task
   checks, starting with the skills whose guidance changes next.
3. Resolve the open gaps.
