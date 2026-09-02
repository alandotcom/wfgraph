---
"@wfgraph/core": minor
"@wfgraph/client": minor
---

Add a Start Filter to each Start Event: the condition an arrival must satisfy before a run opens. It is read after the Event is confirmed to hold the start role and before Concurrency, so an arrival the filter declines opens no Execution and displaces nothing under newest-wins. A Condition node behind the Started outlet cannot do this, because by the time it runs the Execution already exists and Concurrency has already superseded whatever was in flight (ADR-0016).

A declined arrival writes one `run_refused` audit row and appears in the Refused Starts panel; parked Wait nodes in the same workflow still receive the Event. A filter that cannot be evaluated against the payload declines the start too, on the same reasoning a Wait match uses, and says so on the row.

The Lifecycle panel collapses the filter onto the Start Events that agree, offering the fields all of them declare plus the row naming the arriving Event, and splits into one control per Event on request or when the filters diverge. Publishing refuses a filter that is unfinished, that reads a field its Start Event does not declare, or that compares against a value only a run would hold.
