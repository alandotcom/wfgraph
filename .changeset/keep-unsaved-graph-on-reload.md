---
"@wfgraph/client": patch
---

Reopening the workflow already on screen no longer discards edits the server has not stored. The route loader refetched the workflow and hydrated it unconditionally, and selecting a run or leaving Runs re-runs that loader, so a graph the autosave queue was still holding could be replaced by the server's older copy.

The case this loses work in is a failed save. The dirty flag stays raised on that path by design, so the editor keeps showing the edit and the strip keeps reporting the failure. A route re-run then installed the server's graph and lowered the flag, taking the edit and the failure notice together and leaving nothing on screen to say the work had gone.

Hydration now keeps the local graph when the route resolves the workflow already open and the client is ahead of the server, meaning there are unsaved changes or a write in flight. Opening a different workflow still replaces the graph, and so does reopening this one once the save queue has drained.
