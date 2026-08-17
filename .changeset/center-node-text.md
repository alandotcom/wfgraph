---
"@wfgraph/client": patch
---

Centre the title and description on a canvas node again. Both are full-width
truncating blocks, so the stack's `items-center` was centring the icon alone and
leaving the words against the left edge.

Draw a node's icon at 24px rather than 32px, which gives the two lines of text
more of the card.
