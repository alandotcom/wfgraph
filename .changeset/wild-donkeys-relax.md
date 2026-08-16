---
"@wfgraph/plugins": major
---

Remove the Acuity integration. `@wfgraph/plugins` now ships five built-ins (Clerk, Linear,
Resend, Slack, Twilio), the `acuity` export and its `integrationUi` entry are gone, and the
`@fountain-bio/acuity` dependency is dropped. A host importing `acuity` by name must delete
that import; a host passing `builtInIntegrations` needs no change. Stored `acuity`
connections and any workflow node on an `acuity/*` action no longer resolve to a registered
integration.
