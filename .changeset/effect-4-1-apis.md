---
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

`callExternal` now reads a `Retry-After` header given as an HTTP date as well as one given in seconds. `ExternalRejected.retryAfterSeconds` carries the wait measured from when the refusal arrived, so a date-form value can hold a fraction. A digit string too long to be a number now counts as a wait past the ceiling, so a 429 that carries one ends on its first attempt.

A duration written as a bare `P` or `PT` is now refused. It used to read as zero, so a Wait or an Event duration field holding one passed validation and waited for nothing. ISO 8601 durations are now parsed by Effect's `Duration.fromIso`.
