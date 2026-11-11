---
"@wfgraph/client": patch
---

When a publish is refused because the draft was saved elsewhere during the review, the editor now ends the review and asks for the publish to be reviewed again. The review used to stay open on the old draft revision, so every retry failed the same way. Ending the review lets the newer draft load on a clean canvas, or be reported as "Draft changed elsewhere" beside unsaved edits.
