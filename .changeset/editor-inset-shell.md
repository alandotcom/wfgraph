---
"@wfgraph/client": patch
---

Sit the editor inside a margin, on a page a step off the shell.

The editor used to fill the viewport edge to edge, which left it looking like
the window rather than something in it. It now sits 12px in on all four sides,
with a `--radius-xl` corner, a hairline border and a whisper of shadow. The
surface behind it is a new token, `--page` (`bg-page`), a step off the base
surface in whichever direction the theme layers: down from Paper in light, and
up from Void in dark, where nothing renders darker and the shell has to stay
Void because that is the field the graph floats on. Below `md` the inset, the
corner and the border all go, since 24px of a phone's width buys nothing and the
status strip needs the bottom edge of the screen for the home indicator.

The properties panel's width is now a share of that inset shell rather than of
the window, and its resize drag measures the same box, so the released edge
still lands under the pointer.

Dropping a connection on empty canvas now creates the node under the cursor. The
release point was being measured from the canvas pane's own corner and handed to
a converter that wanted window coordinates, which placed every such node up and
to the left by however far the pane sat from the window's corner.
