---
"@wfgraph/core": minor
"@wfgraph/client": minor
"@wfgraph/plugins": minor
---

Add a PostHog integration with two actions, Capture Event and Identify Person, both posting to PostHog's capture endpoint with a project API key and an API host that defaults to US Cloud. Each event is sent under a uuid and timestamp taken in a memoized step, so a retried send collapses into the original rather than arriving twice.
