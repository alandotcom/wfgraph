---
"@wfgraph/core": patch
"@wfgraph/client": patch
"@wfgraph/shared": patch
---

Stop sending start and result payloads on the run-list procedures.

`getExecutions` polls every two seconds while the Runs tab is open, and
`getExecutionsGlobal` pages the dashboard. Neither list paints `input` or
`output`, yet both selected those JSONB columns and redacted them on every
answer. Payloads stay on `getExecutionLogs`, which is fetched for the one open
run.
