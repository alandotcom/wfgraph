---
"@wfgraph/core": patch
"@wfgraph/client": patch
"@wfgraph/plugins": patch
"@wfgraph/shared": patch
---

Bump es-toolkit to 1.52 and import it by subpath. The published option types now declare `| undefined` on their optional properties, which matters to an adopter compiling with `exactOptionalPropertyTypes`: a maybe-undefined value can now be passed straight into an optional field instead of being filtered out first.
