---
"@wfgraph/core": patch
"@wfgraph/plugins": patch
---

Each Agent Skill in `@wfgraph/core` and `@wfgraph/plugins` now has a `description` that says when a coding agent should load it, including requests that name no Workflow Graph API, and which skill to load for the neighboring task. The previous description text moves unchanged to `metadata.purpose`. The guidance in each skill is unchanged.
