# @wfgraph/plugins

The six built-in integrations for
[Workflow Graph](https://github.com/alandotcom/wfgraph): Clerk, Linear, PostHog, Resend, Slack, and
Twilio.

```bash
npm install @wfgraph/plugins
```

Each integration has its own entry, and each entry exports a function with the integration's
name: `@wfgraph/plugins/clerk` exports `clerk`, and so on for `linear`, `posthog`, `resend`,
`slack`, and `twilio`. Nothing registers on import. Call each integration your application
uses and pass the results to `createWfGraphApp`:

```ts
import { createWfGraphApp } from "@wfgraph/core";
import { resend } from "@wfgraph/plugins/resend";
import { slack } from "@wfgraph/plugins/slack";

const wfgraph = await createWfGraphApp({
  extensions: {
    integrations: [
      resend(),
      slack({
        oauthClient: {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        },
      }),
    ] /* ...events and actions */,
  },
  // ...the rest
});
```

A process loads only the entries it imports, so a Cloudflare Worker that uses one
integration starts without the other five.

`clerk()`, `linear()`, `posthog()`, `resend()`, and `twilio()` take no arguments and return
the same definition on every call. `slack(options?)` takes optional OAuth client options.

Resend and PostHog include OAuth through a public client metadata document. Slack enables
OAuth when you pass a registered Slack app client. All three retain manual credential
entry. OAuth callback URLs also require `publicUrl` on `createWfGraphApp`.
Resend's webhook Events use the same `publicUrl` to copy a Connection-addressed
intake URL; add the signing secret (`RESEND_WEBHOOK_SECRET`) on that Connection.

`@wfgraph/core` is a peer dependency: an integration is built against it and handed back to it,
so the two must resolve to one copy. They are released together and always share a version.

The `@wfgraph/plugins/ui` entry holds the icons and output renderers the editor draws these
integrations with. It is React and browser-only, and a server importing an integration entry
never pulls React in.

## Docs

- [Embedding](https://github.com/alandotcom/wfgraph/blob/main/docs/embedding.md#built-in-integrations),
  which covers turning the built-in integrations on
- [Integrations](https://github.com/alandotcom/wfgraph/blob/main/docs/integrations.md), which
  covers `defineIntegration`, handlers, schemas, and testing your own

Apache-2.0.
