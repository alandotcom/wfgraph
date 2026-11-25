---
"@wfgraph/plugins": minor
---

Each built-in integration has its own entry, and each integration is a function a host calls. Import an integration from `@wfgraph/plugins/clerk`, `@wfgraph/plugins/linear`, `@wfgraph/plugins/posthog`, `@wfgraph/plugins/resend`, `@wfgraph/plugins/slack` or `@wfgraph/plugins/twilio`, and pass the result of calling it under `extensions.integrations`, for example `integrations: [resend(), slack({ oauthClient })]`. `clerk()`, `linear()`, `posthog()`, `resend()` and `twilio()` take no arguments; `slack(options?)` takes the same options as before. The root `@wfgraph/plugins` entry is removed, along with `builtInIntegrations` and `BuiltInIntegrationsOptions`, so a host that used all six writes six imports. `@wfgraph/plugins/ui` is unchanged. A host now loads only the integrations it imports, which keeps a Cloudflare Worker inside the platform's startup time limit.
