---
"@wfgraph/plugins": major
---

Add OAuth connections for Resend and Slack. Call `builtInIntegrations()` to configure the built-in set, and pass `slack.oauthClient` to enable Slack OAuth. Clerk, Linear, Resend, and Twilio remain exported integration values; Slack is a factory because it accepts host-provided client credentials.

Core owns browser-bound, one-use authorization attempts, PKCE, encrypted grants, serialized token refresh, and revoke-before-delete behavior. A new OAuth connection is stored only after its authorization callback succeeds.
