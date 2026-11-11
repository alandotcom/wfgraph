---
"@wfgraph/core": patch
---

`agent.reasoningEffort` defaults to `high` when `agent.provider` is `anthropic`. It defaulted to `medium`. On the eval suite `claude-sonnet-5-5` followed the authoring rules far more often at `high`, for about one more second per turn.
