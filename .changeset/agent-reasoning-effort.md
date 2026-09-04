---
"@wfgraph/core": minor
---

Let a host choose how hard the build agent thinks, and pin the default.

`agent.reasoningEffort` takes `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, and reaches the provider unchanged. Nothing set an effort before, so every turn ran at the provider's default for the configured model. That default belongs to the provider and can move without any change on an adopter's side, which is reason enough to name it here.

The default is `medium`, which is what `gpt-5.6` defaults to today, so this pins current behaviour rather than altering it. Measuring `high` against it over twenty trials per arm separated nothing: 16 of 20 against 12 of 20 on one suite, 21 of 21 against 19 of 21 on another, and no failure in either arm was one more thinking would fix. A host who wants more can ask for it.
