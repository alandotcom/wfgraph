---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

A Condition rule can name the step its field comes from, stored as `$node:<node id>.<path>`, and the engine reads that step's value even where a later step offers the same path. The editor's field picker lists a path two steps offer once under each step and writes the rule naming the one picked. The build agent's `set_condition` takes a `sourceNodeId` per rule, writes the rule naming that step, and refuses a rule without one when more than one step above the Condition offers its path. Publish and a draft run refuse a rule naming a step that is not above the Condition or no longer in the graph. A rule stored with its path alone runs as it did, reading the later step, and the editor warns when more than one step above the Condition offers its path; picking the field again names the step.
