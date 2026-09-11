---
"@wfgraph/core": patch
---

Recover the runs that a Cancel claim or a delivery retry used to strand.

- A Wait behind the Canceled outlet now parks, wakes on its Event, and runs as a durable branch; before, the Cancel claim refused the park and the cleanup nodes behind it never ran.
- A fatal engine failure that finds a Cancel claim at the terminal write now runs the Canceled outlet before recording `canceled`. An interrupted attempt writes no terminal record, so the retry runs the outlet.
- A retried Event delivery answers from the admission decision an earlier attempt committed before it reads the current publication, so a Publish, unpublish, or catalog change between attempts no longer strands a committed Execution at `pending`.
- A woken Wait is settled by the run that consumed it, so a settle write that fails after the signal was accepted no longer leaves the row at `resuming` or reports a failed resume for a run that woke.
- Cancelling a run that is already canceling now answers a conflict instead of an internal failure, so the Runs panel says the run is on its way out rather than reporting a failure.
