---
"@wfgraph/core": minor
---

Refresh every dependency, including sixteen major upgrades.

What an adopter installs changes: `@wfgraph/plugins` now needs `@clerk/backend`
3 and `@linear/sdk` 92, `@wfgraph/core` and `@wfgraph/shared` need
`@marcbachmann/cel-js` 8 and `nanoid` 6, `@wfgraph/shared` needs
`@dagrejs/dagre` 3, and the `@orpc` 2.0 beta line moves to beta.32 across all
six packages. No exported API changed.

Vitest 5 now runs the main suite, as required by `@effect/vitest` rc.113. The
private eval package keeps its own Vitest 4 runner because `vitest-evals` still
caps its peer range below 5.

`@types/node` 26 remains held back because it is ahead of the Node 24 that the
`engines` floor and CI both name. Typing against a newer runtime than the floor
would compile code that fails on it.
