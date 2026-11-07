---
"@wfgraph/core": patch
---

`@wfgraph/core` ships a new Agent Skill, `wfgraph-core/cloudflare-worker`, for deploying Workflow Graph on a Cloudflare Worker: the `wfWorker` entry, the Cron Trigger and the optional wake Queue, Hyperdrive with query caching disabled and the origin role's `search_path`, migrations outside the Worker, and the tick limits and records. The Worker guidance and its two mistakes move there from the wfgraph-core skill, which keeps one routing line.
