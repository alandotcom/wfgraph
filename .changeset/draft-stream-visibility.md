---
"@wfgraph/client": patch
---

The editor closes its draft-revision stream while the browser tab is hidden and opens it again when the tab shows, so a background tab no longer costs the server a database poll. The stream also stays open across the editor's own saves where it used to reconnect after each one.
