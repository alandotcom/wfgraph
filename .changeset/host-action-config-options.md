---
"@wfgraph/core": minor
---

Let host-defined actions supply schema-keyed `options` callbacks for dynamic pickers. Callbacks receive current draft selections, and the editor refreshes dependent choices and clears selections that are no longer available. Authored configuration fields remain available for presentation overrides. Config input and output reference fields can use `showWhen.in` to match any listed variant while preserving existing `equals` conditions.
