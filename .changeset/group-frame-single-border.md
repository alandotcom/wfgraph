---
"@wfgraph/client": patch
---

Paint the Group frame once, and give it back its side gutters. The frame node is
typed `group`, which is also a React Flow built-in type, so its wrapper was
picking up the library's default node border, fill and 10px of padding: a second
rectangle around the frame, inset far enough that the member cards left a 2px gap
at each edge instead of the 12px the layout reserves. The frame's label also
takes the theme's foreground colour in dark mode now, rather than React Flow's
fixed dark grey.
