---
"@wfgraph/core": minor
---

`auth` on `createWfGraphApp` and `wfWorker` now takes the authenticate function itself, `(request) => access | null | undefined`, as well as an object holding it as `authenticate`. An answer of `undefined` is a request that is not signed in and gets a 401, where it used to be a 500; a role lookup such as `WfGraphRoles[session.role]` that finds no role is the common case. `createWfGraphApp` now refuses an `auth` that is neither form at startup with a message naming the option, where a JavaScript host used to start and answer 500 to every operator request. `defineWfGraphAuth` now returns the function it is given, unchanged, and the new `WfGraphAuthenticate` type names that function.
