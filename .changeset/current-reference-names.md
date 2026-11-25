---
"@wfgraph/client": patch
"@wfgraph/core": patch
---

Settings summaries in Canvas Reveal's Browse level, condition summaries, and the value chips of a set comparison name a template reference by its source step's current name, or by the catalog label of the workflow's tracked Entity. A reference to an Entity the workflow does not track keeps its stored label, as its badge in the editor does. They used to show the label stored inside the reference, which still held a step's old name after the step was renamed. The workflow issue raised when a step reads one that is not upstream of it now names the referenced step the same way, and a referenced step with no label and no action reads "Action", "Lifecycle" or "Node" where it read the node id. A broken reference to the tracked Entity, and the server's validation message about an Entity reference, name the Entity by its catalog label. A broken reference to the tracked Entity inside a Condition names the Entity by its catalog label too.
