---
"@wfgraph/client": patch
---

Release the editor canvas whenever no surface is left showing the open run.

Opening a run pins its published graph to the canvas and locks editing, and only
the Runs panel's own controls released it. Two ways of hiding the panel did not:
closing the node config sheet on a narrow viewport, and collapsing the rail on a
wide one. Both leave the Runs tab selected with its tab bar off screen, so the
run stayed pinned and every edit was refused with nothing on screen to say why.
Each now closes the run as it goes, and the panel comes back on Properties.

Opening an overlay now runs the `onClose` of whatever it replaces, matching every
other path that takes an overlay off the stack. Tapping Test Run while the config
sheet was up discarded the sheet silently, which was the same locked canvas by a
third route.

The Runs panel's Back button no longer leaves the Runs tab. It clears the open
run and returns to the runs list its label names, which is what the route's tab
rule now allows: a run in the URL opens the Runs tab, and its absence leaves the
panel's own tab alone.
