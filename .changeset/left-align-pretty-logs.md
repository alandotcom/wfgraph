---
"@wfgraph/core": minor
---

Left-align the pretty console layout and stack a record's fields beneath it.

`configureWfGraphLogging` now renders through Workflow Graph's own formatter.
`@logtape/pretty` right-aligned every field key against the header width, which
put each field line past column 55 of a terminal and wrapped it back to column 0. That library exposes no option for it.

A record now prints one flush-left header line carrying time, level, category
and message, then one row per field at a two-space indent under box-drawing
connectors. A grouped field stays on one line as `key=value` pairs while it
fits, and opens into a row per member when it does not. `LOG_PRETTY_WIDTH` sets
the column it has to fit inside, and `NO_COLOR` turns the escapes off.
