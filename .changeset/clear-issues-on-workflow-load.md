---
"@wfgraph/client": patch
---

Loading a workflow drops the previous one's issues.

`loadWorkflowGraphAtom` cleared selection, undo history and the dirty flag, and
left `workflowIssuesAtom` holding what the last graph was accused of. The
collector is debounced by 300ms, so for that window the toolbar chip counted
faults against a canvas whose node ids no longer matched, and the badges it
claims to agree with had already gone with the old nodes. The load now empties
the list, which is the state a first open already starts in.
