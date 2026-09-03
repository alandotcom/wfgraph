---
"@wfgraph/core": patch
---

Add complete build-agent trace artifacts to the private eval harness. Production logs report payload-free token usage, model calls, finish reasons, refusal counts, and graph revision counts. Incomplete provider finishes now fail the turn.
