# @wfgraph/client

The visual editor for [Workflow Graph](https://github.com/alandotcom/wfgraph), shipped as a
built single-page bundle. Your team builds workflow graphs and declares Lifecycle Rules here,
against the Events and actions your code declared with
[`@wfgraph/core`](https://www.npmjs.com/package/@wfgraph/core).

```bash
npm install @wfgraph/client
```

The package exports one value, a pointer to the built assets on disk. Workflow Graph's server
does not depend on this package and cannot find it on its own, so passing it is what turns the
UI on.

```ts
import { clientBundle } from "@wfgraph/client";
import { createWfGraphApp } from "@wfgraph/core";

const wfgraph = await createWfGraphApp({
  client: clientBundle /* ...the rest */,
});
```

Nothing here is a React component you render yourself, and the package has no runtime
dependencies: React, the graph canvas, and the stylesheet are already inside the bundle. It is
released in lockstep with `@wfgraph/core` and always carries the same version, because the
editor speaks that version's API contract.

## Docs

- [Embedding](https://github.com/alandotcom/wfgraph/blob/main/docs/embedding.md), which covers
  serving the editor and the SPA path rule
- [Product and design vocabulary](https://github.com/alandotcom/wfgraph/blob/main/packages/client/PRODUCT.md)

Apache-2.0.
