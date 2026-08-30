# @wfgraph/plugins

The six built-in integrations for
[Workflow Graph](https://github.com/alandotcom/wfgraph): Clerk, Linear, PostHog, Resend, Slack, and
Twilio.

```bash
npm install @wfgraph/plugins
```

Nothing registers on import. The line that turns the built-ins on is a line in your own code,
and dropping it is what turns them off.

```ts
import { createWfGraphApp } from "@wfgraph/core";
import { builtInIntegrations } from "@wfgraph/plugins";

const wfgraph = await createWfGraphApp({
  extensions: {
    integrations: builtInIntegrations({
      slack: {
        oauthClient: {
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
        },
      },
    }) /* ...events and actions */,
  },
  // ...the rest
});
```

Resend and PostHog include OAuth through a public client metadata document. Slack enables
OAuth when you pass a registered Slack app client. All three retain manual credential
entry. OAuth callback URLs also require `publicUrl` on `createWfGraphApp`.

Clerk, Linear, PostHog, Resend, and Twilio are also exported as values for a host that wants
some of the six rather than all of them. Slack is a factory because it accepts OAuth
client configuration. Selecting individual exports narrows what reaches
`createWfGraphApp`, not what the process loads, because this entry imports all six
integrations.

`@wfgraph/core` is a peer dependency: an integration is built against it and handed back to it,
so the two must resolve to one copy. They are released together and always share a version.

The `@wfgraph/plugins/ui` entry is a separate export holding the icons and output renderers the
editor draws these integrations with. It is React and browser-only, which is why a server
importing the root entry never pulls React in.

## Docs

- [Integrations](https://github.com/alandotcom/wfgraph/blob/main/docs/integrations.md), which
  covers `defineIntegration`, handlers, schemas, and testing your own

Apache-2.0.
