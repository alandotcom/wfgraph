---
"@wfgraph/core": patch
---

A Wait that a Migration re-parks no longer records a false "Skipped delay branch" timeline entry. When the run's next pass resolved the Wait's first attempt again under the new Workflow Version, a delay that would now be past due or beyond its maximum lateness wrote a `run_skipped` entry and closed the Wait's run-log row as a skipped success, even though the run had already parked and went on to resume. Resolving an attempt now writes nothing, and only the attempt's own prepare step records a skip or an error.
