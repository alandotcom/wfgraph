---
"@wfgraph/core": patch
---

A resend of a failed Event delivery's key no longer wakes a run a second time. A delivery that fails for good now keeps its step memo, in a new `settled` schedule state, and the resend that reopens it answers every workflow the first delivery reached from that memo, including the Waits it woke, and retries only the workflows that failed, each with a full set of retries. Run the new PostgreSQL migration (`@wfgraph/core/migrate`) before deploying; SQLite migrates on open.
