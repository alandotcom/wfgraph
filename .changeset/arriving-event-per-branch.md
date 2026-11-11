---
"@wfgraph/core": patch
---

The Arriving Event is now carried per branch, as CONTEXT.md defines it. A node reads the Event, and the payload it addresses through the entry node, of the nearest Wait above it on its own path. It used to be one value for the whole run, so when a pass replayed two event-mode Waits on parallel branches, whichever finished last set the Event and the entry payload for every branch: a node below one Wait could render the other Wait's payload, or an empty one after the other Wait timed out, and an Event Split there could route nowhere. A node joining branches that carry different arrivals takes the one on its incoming edge listed first in the graph. The run's own `outputs` now keep the Start Event's payload for the entry node.
