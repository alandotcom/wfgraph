# Every action carries its UI parts

Proposed. Not started.

Goal: an action written with `defineAction` can ship an icon component and a custom
output renderer, the same as an action that belongs to an integration. Today only an
integration's action can, and the reason is a lookup key rather than a decision anyone
made.

## What is wrong

`integrationUi` (`packages/plugins/src/ui.ts`) is a record keyed by integration type.
Three readers reach an action's React parts through the integration that owns it:

| Reader                                                                | What it looks up         | Fallback when the key is absent |
| --------------------------------------------------------------------- | ------------------------ | ------------------------------- |
| `packages/client/src/components/integration-icon.tsx`                 | `icon`                   | `HelpCircle`                    |
| `packages/client/src/components/workflow/nodes/action-node.tsx:349`   | `icon`                   | a generic node icon             |
| `packages/client/src/components/workflow/workflow-run-shared.tsx:269` | `outputComponents[slug]` | the plain base64 image view     |

An action from `defineAction` has no owner in the catalog to look up with.
`readHostAction` (`packages/core/src/backend/extensions/extension-set.ts:312`) copies
`logoUrl` and never writes `integration`, because that action belongs to no integration.
All three readers therefore take their fallback, and `logoUrl` is the whole of what an
internal action gets.

### The obvious repair breaks the connection picker

Giving an internal action an `integration` value would make the editor demand a
connection for it. One catalog field answers two questions today:

- `action-node.tsx:329` reads a present `integration` as "this node needs a connection",
  and `action-node.tsx:527` draws the missing-connection warning from it.
- `action-node.tsx:349` and `workflow-run-shared.tsx:272` read the same field as "this is
  who draws the node".

Ownership and the need for a connection are separate facts. An internal action has an
owner and needs no connection.

### A host cannot reach the record at all

`packages/client/src/main.tsx:8` imports `integrationUi` from `@wfgraph/plugins/ui` and
passes it to the provider at line 110. The import is fixed at the SPA's build. A host
hands `createWfGraphApp` a built bundle, so a host that writes an icon component has no way
to get it in. Keying the record correctly is worthless while the only writer is one
import inside the bundle.

## The change

**1. Split the catalog field in two.** In `packages/shared/src/extensions/catalog.ts`,
`ActionMetadata.integration` keeps one meaning: this action runs against a connection of
this type, and the editor must ask for one. Add `owner`, naming the entry in the UI
record. Assembly sets `owner` equal to `integration` for an integration's action
(`extension-set.ts:277`), so nothing about the six built-ins changes.

**2. `defineAction` accepts an optional `owner`.** An internal extension that ships React
parts names one. `readHostAction` copies it into the metadata.

**3. Point the three readers at `owner`.** `needsIntegration` (`action-node.tsx:329`) and
the missing-connection warning keep reading `integration`. Nothing else does.

**4. Give the record a second writer.** `WfGraphClientBundle` in `packages/core/src/app.ts`
already carries what a host hands over for the editor. Add a way for a host to pass its
own record of React parts, merged over the built-in one before it reaches
`IntegrationUiProvider`. The merge is by key, and a host key wins, so a host may also
replace a built-in icon.

The mechanism is the open question. The SPA is a built bundle, so the host's components
cannot arrive as an import inside it. Two candidates:

- The host builds the SPA entry itself, and `main.tsx` becomes an exported function
  taking the record. This is honest and costs the host a build step.
- Workflow Graph exposes a global the host's own script fills before the bundle runs. This costs
  the host nothing and gives up type safety at the seam.

Decide this before phase 3 starts.

**5. Rename the vocabulary.** `IntegrationUi` becomes `ExtensionUi`, and
`useIntegrationUi` becomes `useExtensionUi`. The type moves out of `@wfgraph/plugins/ui`,
which a host must not have to depend on, into `@wfgraph/shared`. `@wfgraph/plugins/ui` keeps
exporting the record of the six built-ins and nothing else.

## Phases

Each phase ends green. Run the full check list from AGENTS.md before every commit.

1. **Catalog split.** Add `owner`, set it at assembly, point the three readers at it.
   Test: an internal action with an `owner` draws its icon; an internal action with an
   `owner` shows no connection picker.
2. **Vocabulary.** Rename the type and the hook, move the type to `@wfgraph/shared`.
3. **Host record.** Whichever of the two mechanisms above is chosen, plus a worked
   example in `examples/`.

## What must not regress

- An action with no `owner` and no `integration` still draws, with the generic icon.
- `logoUrl` still works. It stays the cheap path for an action that wants an image and
  no component.
- The server bundle still carries no React. Only `@wfgraph/plugins/ui` and the new host
  record hold components, and neither is reachable from `@wfgraph/plugins`.
