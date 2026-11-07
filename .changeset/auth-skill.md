---
"@wfgraph/core": patch
---

`@wfgraph/core` ships a new Agent Skill, `wfgraph-core/auth`, for writing the `auth` access policy: mapping host sessions to the viewer, editor and admin role policies, building a custom policy from the host's own grants with `WfGraphAccess.fromPermissions`, choosing `trustWfGraphUpstream()`, and reading the `401`, `403` and `500` answers. The wfgraph-core skill now routes there for policy guidance, and it states that a JavaScript host that omits `auth` still starts and answers `500` to every operator request.
