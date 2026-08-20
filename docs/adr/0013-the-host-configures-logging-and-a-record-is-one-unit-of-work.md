# 13. The host configures logging, and a record is one unit of work

Date: 2026-08-11

## Status

Accepted.

## Context

The backend log had become unreadable. One `pnpm run dev` session covering a
boot, four RPC calls and one four-node workflow run wrote 1070 lines of output
carrying 63 records. Around 94% of the output was continuation lines of
pretty-printed JSON. Three separate causes were measured.

`api-app.ts` logged the full request body and the full response body of every
request in development, each truncated at 8192 characters and inspected to a
depth of 8. One call of `GET /api/extensions` printed 40 lines, and one call of
`POST /api/rpc/workflow/create` printed 88.

The run engine narrated its steps. A single node wrote four to six records
(`Executing node`, `Executing action node`, `Calling executeActionStep`, `Node
execution completed`, `Executing downstream nodes in parallel`), and the
four-node probe run wrote about 40.

Every engine record repeated six flat identity fields. The pretty formatter
prints one top-level field per line and offers no inline option, so a one-line
`Executing node` record occupied eight lines.

Ownership was the second problem. `getAppLogger` called `configureSync` lazily,
which made `@wfgraph/core` the owner of a global its host also owns. The LogTape
library manual asks a library to do neither that nor claim a generic category,
and the root category was `app`. Passing the `logger` option called `resetSync`
on whatever a host had installed, without saying so.

## Decision

The host configures LogTape. `backend/lib/logger.ts` holds `getAppLogger` and
the `wfgraph` root and calls no `configure`. A host installs the shipped console
setup with `configureWfGraphLogging()` from the new `@wfgraph/core/logging`
entry, passes a `WfGraphLogger` as the `logger` option, or writes its own
LogTape configuration with a sink for the `wfgraph` category. An unconfigured
LogTape drops records silently, so `createWfGraphApp` and `wfWorker` print one
notice naming all three ways when they find `getConfig() === null`.

A record is one unit of work. One HTTP request writes one record, and the oRPC
handler puts a refusal on a per-request accumulator the middleware owns rather
than writing a second. One node execution writes one record carrying its status,
its elapsed time, and whichever of halting or a condition value applied. A run
writes one record when it starts and one when it ends. The step narration is
deleted rather than demoted, because a `debug` record still has to be read past.

No payload is logged. The request body, the response body, the start payload and
the request payload are all persisted where they can be read whole.

Fields are grouped by subject. A record carries `http`, `rpc`, `run`, `node`,
`outcome` or `error` as objects rather than as flat keys, and the pretty
formatter is given `breakLength: 200` so a group stays on one line. The JSON
line puts each group at the top level of the object, which a log store addresses
as `run.execution`. Categories are one level deep under `wfgraph`, since
`categoryWidth` is paid on every line. The engine writes two versions of its run
group: the full identity on the record that opens a run, and the two
correlation ids on every record after it, because a full identity repeated per
line is as wide as a terminal.

The Inngest SDK's `internalLogger` is given an adapter over the same category,
so the Connect handshake stops printing four unformatted lines and a bare object
through the SDK's own console logger. The adapter sends the SDK's `info` to
`debug`, because Workflow Graph writes its own record for the outcome of the
handshake and the SDK's four are the narration behind it. Its `warn` and `error`
keep their level. `ctx.logger` inside a handler is the separate `logger` option
and is left as the SDK's own, so a host's handler keeps what it had.

## Consequences

An adopter who configures nothing sees no output. That is the cost of the
library owning none of the configuration, and the start-up notice is what makes
it a two-minute problem rather than an afternoon.

The `logger` option keeps its `resetSync`, and the doc comment now states that
it replaces a host's own configuration. A host with its own LogTape setup is
pointed at the sink-for-a-category route instead.

The engine's per-node record is `info`, which is also the new default level in
development. `debug` was the old default, and what made it worth having was the
narration this ADR deletes.

Some detail is gone rather than moved. The downstream node ids, the condition
node's skip reason and the "already in progress" case were `debug` records; the
first two now ride on the node's own record where they are cheap, and the third
is left to the trace the store writes.

The measured result on the same probe run: 1070 lines carrying 63 records
became 73 lines carrying 25, and no record occupies more than four lines.

## Amendment, 2026-08-17

The renderer behind the pretty layout is now Workflow Graph's own,
`backend/lib/pretty-formatter.ts`, and `@logtape/pretty` is gone from the
dependencies.

That library right-aligns every field key against the header width. The pad it
applies is `indentWidth - width(key) - 2`, where `indentWidth` covers the
timestamp, the icon slot, the padded level and `categoryWidth`. The settings
this ADR arrived at put that near 49 columns, and `concurrently` adds six more
during `pnpm run dev`, so each field line began past column 55 and wrapped back
to column 0 in an 80-column terminal. The library exposes no option for it;
`align: false` keeps the same calculation and only makes the gutter change size
per record.

The layout is now flush left: a header line carrying time, level, category and
message, then one row per field at a two-space indent under box-drawing
connectors. The grouping decision holds. A group still prints on one line, as
`key=value` pairs, while the line fits `LOG_PRETTY_WIDTH`; a group too wide for
that opens into a row per member. That width replaces the `breakLength: 200`
this ADR named.
