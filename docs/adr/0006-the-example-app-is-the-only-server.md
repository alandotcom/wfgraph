# The example app is the only server

_Decided 2026-07-28 by Alan Cohen, following the stage-1 architecture review._

WfGraph publishes no server. `createWfGraphApp` returns a fetch handler and the host mounts it,
which is the whole of the contract an adopter takes on. Until now the repo also carried a
server of its own at the root, `server.ts`, and it had grown into something no adopter
would recognise: Vite in middleware mode inside the same process, a dispatch table
deciding which of WfGraph and Vite saw a request first, a second copy of the SPA-path rule,
a loopback bind guarding Vite's `/@fs` route, and HMR wired onto the shared HTTP server.

The repo now has one server, and it is the example app at `examples/app.ts`. It reads its
options from the environment, registers a custom trigger and a custom action, and mounts
WfGraph on `node:http` through `createRequestListener`. Nothing from the old root server
moves into it. `pnpm run dev` runs it beside a plain Vite dev server in `packages/client`,
which compiles the SPA on its own port and proxies `/api` to the app. `pnpm run start`
runs the same file with `NODE_ENV=production`, where it hands the built bundle to
`createWfGraphApp` as `client`, which is the path a deployment takes.

The bar for a line in that file is whether an adopter would write it. Anything that exists
only for this repo's dev loop belongs in a script or a config, not in the app.

## Considered Options

- **Keep the integrated dev server** rejected: it is code no adopter runs, so the effort
  spent on it bought nothing that ships, and the divergence it created was the expensive
  part. Development served the SPA through a rule the root server owned while production
  served it through WfGraph's, so a routing question had two answers. The stage-1 review's
  dispatch-ownership and file-exposure findings both lived in that file, and the fix for
  each was more dispatch logic in the place least like production.
- **Keep `server.ts` as a thin wrapper and let it import the example's registrations**
  rejected: two entrypoints for one process, where the one the repo runs is still not the
  one it documents.

## Consequences

- Development is two processes on two ports. The editor is at Vite's port, the API at the
  app's, and the proxy is the only thing joining them. A developer who starts only the app
  gets the API alone.
- The webhook URL the editor's trigger panel offers for copying is built from
  `window.location.origin`, so in development it names Vite's port rather than the app's.
  A `curl` from the same machine still works, since the proxy forwards `/api` to the app,
  but a sender outside the browser, a tunnel or a third-party service, has to be given the
  app's port instead. Production has one origin and the question does not arise.
- The `isSpaPath` rule in `packages/core/src/backend/lib/http/client-assets.ts` has one
  caller again. Vite's own history fallback answers a page view in development, so nothing
  outside WfGraph applies the rule and the two modes cannot disagree about it.
- The example app carries the repo's dev-loop defaults, port 4017 and the local Postgres
  URL, which is what a reader of an example expects to be able to change and what an
  adopter would write for their own machine anyway.
- The Vite toolchain moves onto `packages/client`, and the root builds nothing itself:
  `pnpm run build` is `pnpm -r build`, with the order derived from the workspace graph.
