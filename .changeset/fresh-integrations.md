---
"@wfgraph/plugins": major
---

Convert built-in integrations to factories and add OAuth connections for Resend and Slack. Call `builtInIntegrations()` and use `clerk()`, `linear()`, `resend()`, `slack()`, or `twilio()` when selecting integrations individually. Pass `slack.oauthClient` to `builtInIntegrations()` to enable Slack OAuth.
