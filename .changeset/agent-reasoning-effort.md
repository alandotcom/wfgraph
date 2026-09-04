---
"@wfgraph/core": minor
---

Let a host choose how hard the build agent thinks, and pin the default.

`agent.reasoningEffort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and reaches the provider unchanged. Nothing set an effort before, so every turn ran at the provider's default for the configured model, which for `gpt-5.6` is `medium`. That default belongs to the provider and can move without any change on an adopter's side, which is reason enough to name it here.

The default is `high`. That is a judgement rather than a measured win, and `DEFAULT_AGENT_REASONING_EFFORT` records what was measured and why it settles nothing. A host who would rather pay less latency and fewer tokens sets this to `medium` and gets the previous behaviour exactly.
