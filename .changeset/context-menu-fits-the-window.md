---
"@wfgraph/client": patch
---

Keep the canvas context menu inside the window. An item that explains why it is
disabled now wraps its reason at a capped width rather than stretching the menu
off the right edge, the menu opens upward when the pointer sits near the bottom,
and it renders on the body so the properties panel no longer paints over it. A
disabled row drops its keyboard shortcut, since the key does nothing there.
