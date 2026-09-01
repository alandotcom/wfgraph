---
"@wfgraph/core": major
"@wfgraph/client": major
---

Replace the host `auth` predicate with an authentication and authorization contract. Hosts now return a principal from `authenticate` and can decide each protected operation through `authorize`, using the exported operation, permission, and role-preset constants.

The authenticated extension bootstrap now carries every granted operation ID before the editor renders. The editor uses this page-lifetime snapshot synchronously to adapt controls and data requests. Account and policy changes require a page reload, and server-side authorization remains authoritative for every RPC, REST, and OAuth request.
