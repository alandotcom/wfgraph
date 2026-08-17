---
"@wfgraph/client": minor
---

Draw the canvas in a stroke a reader can follow.

A node card is Paper on a Paper canvas, so its border is the whole card edge,
and it was a `--border` hairline measuring 1.20:1. Edges came off the same
token, and an edge into a subtree the run cannot reach then had 40% opacity
laid over that, leaving nothing on screen. Two tokens replace it:
`--canvas-line` at 3.95:1 on Paper and 3.21:1 on Void, carrying a node's
resting border at 1.5px and the live wire; `--canvas-line-muted` at 2.0:1 in
both themes for an unreachable edge, which now says so with a wider dash gap
and a stopped march rather than by fading out.

A Group frame was `bg-muted/40`, which lands near oklch(0.988) over the canvas
and read as transparent. It is a solid fill behind the same 1.5px border, with
a rule under its title, so the canvas, the frame and the member cards are three
tones the eye can order.

Node icons go from 24px to 20px, and the way back to the dashboard is a
breadcrumb beside the workflow switcher rather than the first item inside it.
