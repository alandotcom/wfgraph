---
"@wfgraph/core": patch
---

A burst of `newest-wins` starts for one entity on PostgreSQL no longer fails a start with "could not serialize access due to concurrent update".

Each such start updates the in-flight row every other racer read, so PostgreSQL commits about one of them per round and aborts the rest with SQLSTATE 40001. The last of N racers therefore needs about N attempts. The retry allowed six attempts, and its jitter of plus or minus 20 percent kept the racers retrying in step, so six racers could spend the whole budget and twelve usually did.

Both serializable transactions in the execution repository now run through one helper, `serializableTransaction`. It retries on 40001 and on a detected deadlock (40P01), draws each delay uniformly between zero and a capped exponential step, and allows 30 retries. The Worker backend over Hyperdrive uses the same repository and gets the same behavior. SQLite serializes writes with `BEGIN IMMEDIATE` and is unchanged.
