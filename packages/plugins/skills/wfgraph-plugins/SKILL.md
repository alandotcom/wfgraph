---
name: wfgraph-plugins
description: >
  builtInIntegrations, slack(options?) OAuth factory, clerk linear posthog
  resend twilio value exports, publicUrl OAuth routes, @wfgraph/plugins/ui.
  Load when turning on the six built-in integrations or wiring Slack, Resend,
  or PostHog OAuth in the host.
metadata:
  type: core
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/plugins/README.md
---

# Built-in integrations

Clerk, Linear, PostHog, Resend, Slack, and Twilio. Nothing registers on
import. Pass the values into `createWfGraphApp` under
`extensions.integrations`.

Writing a new vendor integration is `@wfgraph/core/plugin`
(wfgraph-core/integrations), not this package's internals.

Copy-paste `builtInIntegrations({ slack: { oauthClient } })` from
`packages/plugins/README.md`. Host `publicUrl` and the OAuth route table:
`docs/embedding.md` ("Built-in integrations").

## Core Patterns

### Some of the six

Clerk, Linear, PostHog, Resend, and Twilio are values. Slack is
`slack(options?)` because it closes over host OAuth client credentials.
Selecting individual exports narrows what reaches `createWfGraphApp`, not
what the process loads: the package still imports all six. `@wfgraph/core`
is a peer; keep one copy.

Omit `slack.oauthClient` to keep Slack manual-only. Resend and PostHog OAuth
use a public client metadata document and need no provider secret. All three
keep manual credential forms when OAuth is available.

Resend also declares webhook Events (`resend/email.delivered` and the rest of
the official types) on the umbrella source `resend/webhook`. Paste the
Connection URL from the Lifecycle Node (or Wait node) and
`RESEND_WEBHOOK_SECRET` from the Resend webhook details page. Copying the URL
needs `publicUrl`.

### OAuth host requirements

OAuth requires `publicUrl`. HTTPS except loopback. Callback stays behind
`auth`; `SameSite=Lax` cookies work, custom request headers on the provider
redirect do not. Core derives callback and metadata URLs from `publicUrl`
plus `basePath`.

### Editor UI

`@wfgraph/plugins/ui` exports `integrationUi` (icons and output renderers).
Browser-only; the server entry does not import React.

## Common Mistakes

### CRITICAL Expect import to enable integrations

Wrong: `import "@wfgraph/plugins"` then `createWfGraphApp({ extensions: {} })`.

Correct: `extensions.integrations: builtInIntegrations()` (or an explicit list).

Source: alandotcom/wfgraph:packages/plugins/README.md

### HIGH Slack OAuth without publicUrl

Wrong: `builtInIntegrations({ slack: { oauthClient } })` with no `publicUrl`.

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
