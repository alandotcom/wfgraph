---
"@wfgraph/core": patch
---

The MCP tool list is about a fifth smaller. A subschema a tool's input repeats, such as the condition groups `set_lifecycle_rules` takes for Entity Eligibility, Start filters and Cancel filters, is listed once under `$defs` and referenced by `$ref`; output schemas carry no description annotations; and the default `additionalProperties: true` is left out. What each schema accepts is unchanged. A condition rule's `amount` is now listed as a finite number with its description.
