---
"@wfgraph/client": patch
---

Draw a Group's interior edges, so parallel members read as parallel. The frame
already kept the store edges naming its children, and the engine still ran them
side by side and joined them at the exit; the canvas painted the members as a
bare grid with no handles, which made a fan-out look like a sequence.

A nested card now carries invisible handles for those edges to meet at, a row
narrower than the widest one is centred so a join sits under everything it
joins, and the rows are spaced far enough apart for the path to be read. An
interior edge is display only: the frame owns every edit, since deleting one
would strand a member.

Ungrouping rebuilds the freed steps at the pitch auto-layout uses, rather than
leaving them overlapping at the compact spacing they had inside the frame.

Hold a member inside its frame until the frame goes. Deleting one on its own
left the frame naming an exit that no longer existed, and the next edge painted
off the frame's outlet named that dead step too; graphology then invented a node
for it and the save failed on an unreadable `Missing key at ["nodes"][6]`. The
context menu says to ungroup first, the config panel offers Ungroup in place of
Delete, and the delete key cancels a batch that reaches into a frame without
taking it. `createSerializedWorkflowGraph` now refuses an edge naming a node the
graph has no node for, and says which edge.
