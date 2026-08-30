---
name: wfgraph-plugins
description: >
  builtInIntegrations, slack(options?) OAuth factory, clerk linear resend twilio
  value exports, publicUrl OAuth routes, @wfgraph/plugins/ui. Load when turning
  on the five built-in integrations or wiring Slack/Resend OAuth in the host.
metadata:
  type: core
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/embedding.md
  - alandotcom/wfgraph:packages/plugins/README.md
---

# Built-in integrations

Clerk, Linear, Resend, Slack, and Twilio. Nothing registers on import. Pass
the values into `createWfGraphApp` under `extensions.integrations`.

Writing a new vendor integration is `@wfgraph/core/plugin` (wfgraph-core/integrations),
not this package's internals.

## Setup

```ts
import { createWfGraphApp } from "@wfgraph/core";
import { builtInIntegrations } from "@wfgraph/plugins";

const wfgraph = await createWfGraphApp({
  publicUrl: "https://workflows.example.com",
  // persistence, encryption, auth, inngest, client
  extensions: {
    integrations: builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        },
      },
    }),
  },
});
```

Omit `slack.oauthClient` to keep Slack manual-only. Resend OAuth uses a public
client metadata document and needs no provider secret. Both keep manual
credential forms when OAuth is available.

OAuth requires `publicUrl`. HTTPS except loopback. Callback stays behind
`auth`; `SameSite=Lax` cookies work, custom request headers on the provider
redirect do not.

| Route                                                  | Who                         |
| ------------------------------------------------------ | --------------------------- |
| `POST /api/integrations/oauth/start`                   | Operator browser, `auth`    |
| `GET /api/integrations/oauth/attempts/:attemptId`      | Originating browser, `auth` |
| `GET /api/integrations/oauth/callback`                 | Provider redirect, `auth`   |
| `GET /api/integrations/oauth/clients/:integrationType` | Provider, public metadata   |

## Core Patterns

### Some of the five

```ts
import { clerk, linear, twilio } from "@wfgraph/plugins";

extensions: {
  integrations: [clerk, linear, twilio];
}
```

Clerk, Linear, Resend, and Twilio are values. Slack is `slack(options?)`
because it closes over host OAuth client credentials.

Selecting individual exports narrows what reaches `createWfGraphApp`, not what
the process loads: the package still imports all five. `@wfgraph/core` is a
peer; keep one copy.

### Editor UI

`@wfgraph/plugins/ui` exports `integrationUi` (icons and output renderers).
Browser-only; the server entry does not import React.

## Common Mistakes

### CRITICAL Expect import to enable integrations

Wrong:

```ts
import "@wfgraph/plugins";
await createWfGraphApp({ extensions: {} });
```

Correct: `extensions.integrations: builtInIntegrations()` (or an explicit list).

Source: alandotcom/wfgraph:packages/plugins/README.md

### HIGH Slack OAuth without publicUrl

Wrong:

```ts
builtInIntegrations({
  slack: { oauthClient: { clientId, clientSecret } },
});
// createWfGraphApp without publicUrl
```

Correct: set `publicUrl` to the external origin. Core derives callback and
metadata URLs from that origin plus `basePath`.

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
