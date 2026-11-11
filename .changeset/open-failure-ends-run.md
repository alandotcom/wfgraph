---
"@wfgraph/core": patch
---

A run whose pass fails while it loads the run, such as on a stored graph that no longer parses or a read the database keeps failing, now ends `failed` after the same number of retries as any other failure outside a step. Each failed load releases the run after a backoff. Before, the run stayed leased until its lease expired and was retried forever.
