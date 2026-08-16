---
"@wfgraph/client": patch
---

Fix the editor canvas staying read-only after the user leaves the Runs tab.
Opening a run pins its published graph to the canvas and locks editing, and the
Runs panel's Back button was the only control that released it. A switch to the
Workflow tab left the run id in the URL, so the canvas kept refusing every edit
with nothing on screen to say why. The pinned graph now reads through the same
Runs-tab gate that the run's status chips already used.
