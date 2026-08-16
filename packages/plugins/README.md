# @wfgraph/plugins

The five built-in integrations for
[Workflow Graph](https://github.com/alandotcom/wfgraph): Clerk, Linear, Resend, Slack, and
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
  extensions: { integrations: builtInIntegrations /* ...events and actions */ },
  // ...the rest
});
```

Each integration is also exported by name, for a host that wants some of the five rather than
all of them. That narrows what reaches `createWfGraphApp` rather than what the process loads,
since this entry imports all five as values.

`@wfgraph/core` is a peer dependency: an integration is built against it and handed back to it,
so the two must resolve to one copy. They are released together and always share a version.

The `@wfgraph/plugins/ui` entry is a separate export holding the icons and output renderers the
editor draws these integrations with. It is React and browser-only, which is why a server
importing the root entry never pulls React in.

## Docs

- [Integrations](https://github.com/alandotcom/wfgraph/blob/main/docs/integrations.md), which
  covers `defineIntegration`, handlers, schemas, and testing your own

Apache-2.0.
