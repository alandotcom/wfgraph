# One assembled JSON catalog

_Decided 2026-07-31 by Alan Cohen, during the architecture pass._

An Event, an action and an integration reach the editor as one value: `ExtensionCatalog`
(`packages/shared/src/extensions/catalog.ts`), served by `GET /api/extensions` and decoded
once by the browser before the first render. `createRovaApp` builds it with
`assembleExtensions` (`packages/core/src/backend/extensions/extension-set.ts`) from the
definitions a host passed, and hands it to the Layer graph as the `Extensions` service.

Before this, each half of an extension was reachable through a module-level registry that
filled itself on import. The editor learned about an integration by importing the file that
declared it, which is the same file holding its vendor SDK, its HTTP client and the code
that decrypts its credentials. Keeping those out of a browser bundle took a `load` loader
on every plugin, and the loader existed for no other reason.

Serialization is the constraint that does the work. A catalog is JSON, so a definition
reaches the browser only as data, and there is no import that could carry anything else.
That is what lets an integration hold its vendor client, its SDK and its secrets in the same
file as its metadata, which is why a plugin in this repo is one file.

## Considered Options

- **A registry per half, imported by both sides** rejected: it is the arrangement this
  decision replaced. It put a server module on the browser's import graph and made every
  plugin pay for a loader to get back off it.
- **A build step emitting browser-safe metadata** rejected: it answers the same question
  with a code generator and a generated artifact that can go stale against the definition
  it was derived from. The server already holds the assembled value at runtime, and one
  route is cheaper than a build.
- **Lenient lookups over the catalog** rejected: a missing surface would give a run that
  dispatches nothing, a save that passes every check, and a config that serves its secrets
  unmasked. Yielding the `Extensions` service puts it in a body's `R` instead, so only a
  runtime carrying a surface can run the code that reads one.

## Consequences

- Assembly is where a definition mistake is caught, and it names the offender. Each of an
  Event's name, an action's id and an integration's type is held to one owner; an output
  schema the field derivation cannot read is refused; so is a required config key with no
  field behind it, and a credential field with no `envVar`.
- The server asks the catalog everything it used to ask a registry: the credential mapping,
  the secret-key masking test, the action labels, step dispatch, and both workflow
  validators. Pure checks take the catalog as a parameter, so a validator cannot reach a
  surface of its own.
- The client holds the catalog as a module value rather than a query-cache entry, because
  the surface is fixed for the life of the server process and the lookups over it run
  during render.
- An icon and a custom output renderer are React components, so they cannot travel as JSON.
  They stay an explicit browser import through `@rova/plugins/ui`, which is the one
  exception and the reason it is a separate entry point.
- Every lookup (`findAction`, `findEvent`, `findIntegration`, `credentialsFromConfig`) is a
  pure function in the shared module, so the server and the browser run one implementation.
