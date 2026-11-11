---
"@wfgraph/core": minor
---

`events.send` on the app and the runner now also takes the value `defineEvent` returned, `events.send(appointmentCreated, data, { id })`, and types `data` from the Event's schema; the `{ name, data, id }` form stays for a sender that holds only a name. The new `events.inboxInsert(event, data, { id })` checks a payload the way a send does and answers the documented `workflow_event_inbox` insert, with the table qualified by the PostgreSQL schema, and its parameters, so a host runs it on its own connection inside its own transaction. `$2` is the payload object on PostgreSQL and JSON text on SQLite, and `namedParams` serves a driver such as `node:sqlite` that binds `$1` by name. `createWfGraphInngestFunctions` now asks only for the `send` by name and the `sourceNames` of the `events` it is handed.
