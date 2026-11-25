---
name: wfgraph-plugins
description: >
  Use when turning on the built-in Workflow Graph integrations from
  @wfgraph/plugins (Clerk, Linear, PostHog, Resend, Slack and Twilio) in a host
  application: importing each integration from its own entry
  (@wfgraph/plugins/slack and so on) and passing the result of calling it in
  extensions.integrations, configuring Slack OAuth with slack({ oauthClient }),
  meeting the publicUrl and session cookie requirements of Slack, Resend and
  PostHog OAuth, receiving Resend webhook Events, deciding what the built-in
  steps do in a test run, or deleting an OAuth connection whose grant the
  provider did not revoke. Also use for requests such as "let workflows send
  Slack messages" or "the Slack OAuth connection fails".
  For writing a new vendor integration use wfgraph-core/integrations; for
  mounting the app itself use wfgraph-core.
metadata:
  purpose: >
    One entry per integration, clerk() linear() posthog() resend() twilio()
    and slack(options?) with its OAuth client, no root entry, publicUrl OAuth
    routes, @wfgraph/plugins/ui.
    Load when turning on the six built-in integrations or wiring Slack, Resend,
    or PostHog OAuth in the host.
  type: core
  library: wfgraph
  library_version: "4.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/plugins/README.md
---

# Built-in integrations

Clerk, Linear, PostHog, Resend, Slack, and Twilio, each in its own entry
(`@wfgraph/plugins/clerk` and so on). Each entry exports a function named
after the integration. Nothing registers on import. Call each function and
pass the results into `createWfGraphApp` under `extensions.integrations`.

Writing a new vendor integration is `@wfgraph/core/plugin`
(wfgraph-core/integrations), not this package's internals.

Copy-paste the integration list with `slack({ oauthClient })` from
`packages/plugins/README.md`. Host `publicUrl` and the OAuth route table:
`docs/embedding.md` ("Built-in integrations").

## Core Patterns

### One entry per integration

The package has no root entry; a host that wants all six writes six imports.
A process loads only the entries it imports, which keeps a Cloudflare
Worker's startup time down. `clerk()`, `linear()`, `posthog()`, `resend()`
and `twilio()` take no arguments and return the same definition on every
call. `slack(options?)` builds a new definition on each call because it
closes over host OAuth client credentials. `@wfgraph/core` is a peer; keep
one copy.

Call `slack()` with no `oauthClient` to keep Slack manual-only. Resend and PostHog OAuth
use a public client metadata document and need no provider secret. All three
keep manual credential forms when OAuth is available.

Resend also declares webhook Events (`resend/email.delivered` and the rest of
the official types) on the umbrella source `resend/webhook`. Paste the
Connection URL from the Lifecycle Node (or Wait node). Add the signing secret
on that Connection (`RESEND_WEBHOOK_SECRET`). Copying the URL needs
`publicUrl`.

### OAuth host requirements

OAuth requires `publicUrl`. HTTPS except loopback. Callback stays behind
`auth`; `SameSite=Lax` cookies work, custom request headers on the provider
redirect do not. Core derives callback and metadata URLs from `publicUrl`
plus `basePath`.

Deleting a connection that holds an OAuth grant always removes it. Workflow
Graph asks the provider to revoke the grant first and answers
`oauthRevocation: "revoked"` or `"not_revoked"`; on `not_revoked` it logs a
warning with the reason, and an admin revokes the app's access in the
provider's own settings. Slack's answer that a workspace already uninstalled
the app counts as revoked.

### Test runs and connection rules

A Draft run, and a run of a workflow in Test mode, call every action. The
Slack, PostHog, Twilio and Resend actions each carry a per-step test setting
that defaults to logging the call and sending nothing. Slack and PostHog can
be set to send for real, and Twilio and Resend to send to a test phone number
or address. Clerk and Linear actions
carry none, so a test run calls them for real.

PostHog's `POSTHOG_HOST` must be an `https:` URL with no user name or
password; a blank host means US Cloud. Resend's Send Email sends an
idempotency key naming its node within the run, so two Send Email nodes in one
run each send.

### Editor UI

`@wfgraph/plugins/ui` exports `integrationUi` (icons and output renderers).
Browser-only; no integration entry imports React.

## Common Mistakes

### CRITICAL Expect import to enable integrations

Wrong: `import "@wfgraph/plugins/slack"` then `createWfGraphApp({ extensions: {} })`.

Correct: `extensions.integrations: [slack()]`, one call per integration.

Source: alandotcom/wfgraph:packages/plugins/README.md

### HIGH Import from the package root or pass an uncalled function

Wrong: `extensions.integrations: [resend, twilio]`, or `import { slack } from "@wfgraph/plugins"`.

Correct: `import { resend } from "@wfgraph/plugins/resend"` and
`import { twilio } from "@wfgraph/plugins/twilio"`, then
`extensions.integrations: [resend(), twilio()]`. Each integration has its own
entry, and the package has no root entry.

Source: alandotcom/wfgraph:packages/plugins/README.md

### HIGH Slack OAuth without publicUrl

Wrong: `slack({ oauthClient })` with no `publicUrl`.

Correct: set `publicUrl` to the external origin.

Source: alandotcom/wfgraph:docs/embedding.md (Built-in integrations)

### HIGH Two copies of @wfgraph/core

Wrong: a nested `@wfgraph/core` from a mismatched plugins install.

Correct: one resolved core (packages are released in lockstep). Duplicate
runtimes split the plugin contract from the app.

Source: alandotcom/wfgraph:docs/embedding.md

### MEDIUM Header-based auth on the OAuth callback

Wrong: `auth` that requires a custom header the provider redirect cannot send.

Correct: session cookie `SameSite=Lax` (or equivalent) so the top-level
redirect still authenticates.

Source: alandotcom/wfgraph:docs/embedding.md
