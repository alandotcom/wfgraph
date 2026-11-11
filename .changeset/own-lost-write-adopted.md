---
"@wfgraph/client": patch
---

A save that the server stored but whose answer never reached the browser no longer becomes a permanent draft conflict. After a draft conflict, or a save with no usable answer, the editor reads the stored draft back. When it holds a graph this editor sent, the editor takes up the stored revision and keeps saving newer edits on top of it. A draft that holds a graph written elsewhere is still reported as "Draft changed elsewhere".
