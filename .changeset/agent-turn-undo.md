---
"@wfgraph/client": minor
---

A finished build agent turn that edited the workflow now says under it what it changed, such as "Added 2 steps, removed 1 step", beside an "Undo changes" button that reverts the whole turn through the editor's Undo. The button is disabled once other edits have been made after the turn, and is not offered for a turn restored from an earlier page load, whose undo history the editor no longer holds.
