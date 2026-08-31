---
"@wfgraph/core": minor
---

Integrations may declare Events and a Connection-addressed webhook. Resend ships all 19 official webhook event types. An integration-owned Start, Cancel, or Wait Event requires a Connection at Publish, and Publish checks that Connection exists and is the integration's own type, the same check an action's connection already got. Two integrations may not both claim one Event, and an integration Event may not declare a payload field at `__wfgraphConnectionId`, which carries the Connection an arrival came through.
