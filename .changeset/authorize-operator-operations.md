---
"@wfgraph/core": major
"@wfgraph/client": major
---

Replace the host `auth` predicate with a principal-free access-policy contract. `defineWfGraphAuth` gives extracted callbacks contextual types; authentication returns `WfGraphRoles.viewer`, `.editor`, `.admin`, another `WfGraphAccess` policy, or `null`. Unrestricted access is explicit through `WfGraphAccess.all` or `trustWfGraphUpstream()`, and Node and Worker APIs no longer carry principal type parameters.

The authenticated extension bootstrap now carries every granted operation ID before the editor renders. The editor uses this page-lifetime snapshot synchronously to adapt controls and data requests. Account and policy changes require a page reload, and server-side authorization remains authoritative for every RPC, REST, and OAuth request. Authentication and policy callback failures now produce a sanitized 500 instead of being misreported as a 401 or 403.
