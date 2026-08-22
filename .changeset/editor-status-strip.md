---
"@wfgraph/client": minor
---

Add a status strip along the bottom of the editor canvas.

The workflow's state used to be assembled from chips scattered through the menu
bar, and a run pinned to the canvas refused every edit with nothing on screen
saying why. One fixed-height row now states mode, publication and save state
with the issue count; when a past run is pinned it reports that run and carries
the way back to the draft, which was previously reachable only from inside the
run panel. The menu bar keeps the controls and loses the badges, and the
bottom-centre test-mode banner is gone: what it explained is on the mode label.
