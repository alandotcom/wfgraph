# @wfgraph/plugins

## 1.0.0

### Major Changes

- [#93](https://github.com/alandotcom/wfgraph/pull/93) [`e83fb18`](https://github.com/alandotcom/wfgraph/commit/e83fb18c1ed52a30cfea1c38aa66b69cd0b6630a) Thanks [@alandotcom](https://github.com/alandotcom)! - Remove the Acuity integration. `@wfgraph/plugins` now ships five built-ins (Clerk, Linear,
  Resend, Slack, Twilio), the `acuity` export and its `integrationUi` entry are gone, and the
  `@fountain-bio/acuity` dependency is dropped. A host importing `acuity` by name must delete
  that import; a host passing `builtInIntegrations` needs no change. Stored `acuity`
  connections and any workflow node on an `acuity/*` action no longer resolve to a registered
  integration.

## 0.3.0

## 0.2.0

## 0.1.0

## 0.0.2

### Patch Changes

- [#84](https://github.com/alandotcom/wfgraph/pull/84) [`33a616f`](https://github.com/alandotcom/wfgraph/commit/33a616f4118adb125f578627a21310a1ca24912f) Thanks [@alandotcom](https://github.com/alandotcom)! - Each package now ships its own README, so its npm page describes what it is rather than
  offering to let someone add one, and declares `engines.node` at the Node 24 floor the repo
  already builds against, so an install on an older runtime warns instead of failing later.

## 0.0.1

### Patch Changes

- First published release. `@wfgraph/core` carries the run engine, the authoring
  vocabulary and `createWfGraphApp`; `@wfgraph/client` carries the editor bundle a
  host hands it; `@wfgraph/plugins` carries the six built-in integrations.
