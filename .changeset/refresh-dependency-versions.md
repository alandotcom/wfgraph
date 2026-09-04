---
"@wfgraph/core": minor
---

Refresh every dependency, including sixteen major upgrades.

What an adopter installs changes: `@wfgraph/plugins` now needs `@clerk/backend`
3 and `@linear/sdk` 92, `@wfgraph/core` and `@wfgraph/shared` need
`@marcbachmann/cel-js` 8 and `nanoid` 6, `@wfgraph/shared` needs
`@dagrejs/dagre` 3, and the `@orpc` 2.0 beta line moves to beta.32 across all
six packages. No exported API changed.

Two upgrades are held back. `vitest` 5 is refused by the `vitest` peer range of
both `@effect/vitest` and `vitest-evals`, each capping at `<5`. `@types/node` 26
is ahead of the Node 24 the `engines` floor and CI both name, and typing against
a newer runtime than the floor would compile code that fails on it.
