# Plugin Development Guide for AI Agents

This document guides AI agents through creating and modifying workflow builder plugins.

## Quick Start

Plugins are now registered via manual static files (no scaffold/discovery scripts).

When creating or modifying a plugin, update these files manually:

1. `plugins/index.ts` - add/remove plugin import
2. `shared/types/integration.ts` - update `IntegrationType` union
3. `plugins/server.ts` - add/remove the step and connection-test registrations
4. `client/lib/output-display-configs.ts` - update if action has image/video/url output config

## Plugin Architecture

Each plugin lives in `plugins/[plugin-name]/` with this structure:

```
plugins/[plugin-name]/
  index.ts          # Plugin definition (actions, form fields, metadata)
  schemas.ts        # What each action takes and returns, as Effect schemas
  credentials.ts    # Credential type definition
  client.ts         # The vendor's HTTP API, over fetch
  client.test.ts    # What the client puts on the wire
  icon.tsx          # SVG icon component
  test.ts           # Connection test function
  steps/
    [action].ts     # Server-side step functions (one per action)
```

`schemas.ts` is a separate file because both ends need it and only one of them is
server code: `index.ts` is metadata the editor loads into the browser and derives
its autocomplete fields from, while `steps/[action].ts` is typed against the same
two constants. A plugin whose steps have not moved to `defineStep` yet has no
`schemas.ts`; twilio is the one to copy.

**Call vendors through `vendor-http.ts`, not their SDK.** `callVendor` takes a
request spec and answers an `Effect` holding the decoded body, over Effect's own
`HttpClient`. It owns the ten-second per-attempt timeout, the retry schedule, the
JSON read, the decode, and the three failures every vendor call can end in:
`VendorUnreachable` (nothing answered), `VendorRejected` (it answered and said
no, carrying its own error body), and `VendorUnreadable` (a success status whose
body is not the documented shape).

A `client.ts` is the adapter above that: the auth header, the endpoints, the
vendor's error-envelope schema, and a function saying what one of its three
failures means in words a person reads. Its calls answer an `Effect`, which a
step yields directly. `runVendorCall` is the Promise seam for the callers that
are not effects: a connection test, which the credentials UI calls, and the steps
stage 6b has still to migrate. Twilio's client is the one to copy.

The retry policy is stated once, in the comment above `RETRY_ATTEMPTS`. Two
retries with jittered exponential backoff from 500ms, a `Retry-After` up to ten
seconds replacing that delay, and only for a request repeating cannot do twice: a
GET or HEAD, a write carrying an idempotency key, or a spec that sets
`safeToRepeat` because the vendor spells a read as a POST the way Slack does. Ten
seconds of elapsed time is the loop's whole budget, so a chain of slow attempts
stops rather than running on for the fifty seconds three timeouts and two waits
at the ceiling would take. Inngest's function-level retry remains the outer
policy for everything longer.

An SDK earns its place only when it carries protocol logic worth borrowing, which
is why `@clerk/backend` (JWT verification), `@linear/sdk` (a typed GraphQL
client), and `@fountain-bio/acuity` stayed and `twilio`, `resend`, and
`@slack/web-api` did not. Those three keep their own transport and their own
error handling, so they do not go through `vendor-http.ts`. The `dependencies`
field on a plugin definition exists for that exception.

## Creating a Plugin

### 1. Plugin Definition (index.ts)

The main plugin file registers the integration and defines its actions:

```typescript
import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { MyServiceIcon } from "./icon";

const myServicePlugin: IntegrationPlugin = {
  // Must match folder name and be unique
  type: "my-service",

  // Display name and description
  label: "My Service",
  description: "Brief description of what this integration does",

  // Icon component
  icon: MyServiceIcon,

  // Credential form fields shown in the integration dialog
  formFields: [
    {
      id: "apiKey",
      label: "API Key",
      type: "password", // "password" | "text" | "url"
      placeholder: "sk_...",
      configKey: "apiKey", // Key stored in database
      envVar: "MY_SERVICE_API_KEY", // Environment variable name
      helpText: "Get your API key from ",
      helpLink: {
        text: "myservice.com/api-keys",
        url: "https://myservice.com/api-keys",
      },
    },
  ],

  // Note: connection tests are wired server-side in
  // backend/services/integrations/integration-test-loaders.ts

  // Actions provided by this integration
  actions: [
    {
      slug: "do-something",
      label: "Do Something",
      description: "Description of what this action does",
      category: "My Service",
      // What the step returns. The editor's template autocomplete is derived
      // from it at registration, so there is no field list to keep in step.
      output: doSomethingOutput,
      configFields: [
        {
          key: "inputField",
          label: "Input Field",
          type: "template-input", // Supports {{NodeName.field}} syntax
          placeholder: "Enter value or use {{NodeName.field}}",
          example: "example value",
          required: true,
        },
      ],
    },
  ],
};

registerIntegration(myServicePlugin);
export default myServicePlugin;
```

### 2. Credentials Type (credentials.ts)

Define the credential fields using environment variable names as keys:

```typescript
export type MyServiceCredentials = {
  MY_SERVICE_API_KEY?: string;
  // Add other credential fields as needed
};
```

### 3. Schemas (schemas.ts)

What the action takes and what it gives back. Both are plain Effect schemas, and
both are imported twice: `index.ts` reads the output one for the editor's
autocomplete, the step is typed against both.

```typescript
import { Schema } from "effect";

export const doSomethingInput = Schema.Struct({
  inputField: Schema.String,
  // `optional`, not `optionalKey`. The engine resolves a node's templates into
  // every config key the action declares, so a field the user left blank
  // arrives as a key holding `undefined` rather than as no key at all, and
  // exact-optional semantics would refuse the config a real run builds.
  optionalField: Schema.optional(Schema.String),
});

export const doSomethingOutput = Schema.Struct({
  // The annotation is the field's description in the editor's autocomplete. It
  // goes on the base type before any `check`, or the check owns it and nests it
  // where the field reader cannot see it.
  id: Schema.String.annotate({ description: "Item ID" }),
  // `optional` again, from the other side: a handler that answers
  // `createdAt: undefined` on one of its paths is describing a key that is
  // present and empty, which is what this says and `optionalKey` does not.
  createdAt: Schema.optional(
    Schema.String.annotate({ description: "When it was created" })
  ),
});
```

The output schema describes JSON. A step result is memoized by Inngest between
steps, so a `Date`, a `Map`, or a `Set` in it would not survive the round trip.

**Registration reads the output schema and refuses one it cannot use.** The root
is a `Schema.Struct`, since a downstream node addresses a payload by named path
and an array or a union of objects has no path to offer. Every field carries a
`description` annotation, because that annotation is what the editor shows beside
the path and the type name it would otherwise fall back to says nothing. A field
whose JSON Schema the reader cannot use drops out of the derived list, which the
count catches: `Schema.Number` on its own describes itself as a number or one of
the strings `"Infinity"`, `"-Infinity"` and `"NaN"`, so a numeric field is
`Schema.Number.annotate({ ... }).check(Schema.isFinite())`. Each of these throws
from `registerIntegration`, naming the action, when the plugin's `index.ts` is
imported.

**What the output schema is checked against, and what it is not.** The handler's
return type comes from it, so a payload that drops a field or renames one fails
to compile. Optionality is not part of that check: this repo leaves
`exactOptionalPropertyTypes` off, so a handler answering `field: undefined`
satisfies an `optionalKey` the same as an `optional`, and only the schema says
which one is true. Nor is the schema enforced at run time. `defineStep` decodes
the input and returns the handler's value as it stands, so a vendor field the
schema calls a string and the handler passes through as a number reaches the run
log unchallenged. The client is where a vendor's answer is decoded, and that is
the check that catches it.

### 4. Step Function (steps/[action].ts)

A step is a `defineStep` over those two schemas and a handler that gets from one
to the other. The handler is the whole file: `defineStep` owns the config decode,
the credential fetch, the run log, and the result envelope.

```typescript
import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import {
  createMyServiceItem,
  describeMyServiceFailure,
} from "#src/my-service/client";
import type { MyServiceCredentials } from "#src/my-service/credentials";
import { doSomethingInput, doSomethingOutput } from "#src/my-service/schemas";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies. Inline it when there is nothing to decide.
 */
export const doSomethingHandler = Effect.fn(function* (
  input: typeof doSomethingInput.Type,
  context: StepRunContext
) {
  // Credentials arrive as an effect, so a step that decides it has nothing to
  // do never reads the integration's secrets. Yielding it twice fetches once.
  const credentials: MyServiceCredentials = yield* context.credentials;
  const apiKey = credentials.MY_SERVICE_API_KEY;

  if (!apiKey) {
    return yield* Effect.fail(
      new StepFailure({
        message:
          "MY_SERVICE_API_KEY is not configured. Please add it in Project Integrations.",
      })
    );
  }

  // The HTTP call lives in the plugin's own client.ts, built on callVendor.
  // Steps stay about what to send and what the answer means.
  const item = yield* createMyServiceItem(apiKey, {
    field: input.inputField,
  }).pipe(
    Effect.mapError(
      (error) =>
        new StepFailure({
          message: `Failed: ${describeMyServiceFailure(error)}`,
        })
    )
  );

  return { id: item.id };
});

export const doSomethingStep = defineStep({
  id: "my-service/do-something",
  input: doSomethingInput,
  output: doSomethingOutput,
  handler: doSomethingHandler,
});
```

**A handler asks for `HttpClient.HttpClient` and nothing else.** `StepHandler`'s
requirements channel names that one service, which is exactly what `defineStep`
provides, so a handler that yields an effect wanting anything more fails to
compile rather than failing at run time inside a workflow. That is the intended
answer. A step that genuinely needs another service is a conversation about what
belongs in a step's environment, held once and settled in `define-step.ts`, not a
type parameter widened at the call site.

What ties the action id to that step lives in `packages/plugins/src/server.ts`,
which the server imports for its side effects. That file also registers the
connection test, and both registrations are lazy on purpose: a step
implementation and a connection test each reach a vendor over the network, and
neither should enter the process until something calls it. The id is checked
against the one the step declares, so the two cannot name different actions, and
the label comes from the action metadata rather than being repeated here.

```typescript
registerStep(
  "my-service/do-something",
  async () =>
    (await import("#src/my-service/steps/do-something")).doSomethingStep
);
```

A step still written as a Promise function registers through
`registerStepFunction` instead. Every one of those is stage 6b of ADR-0002's
work; new steps use `defineStep`.

Test the handler, not the step: it is a function of `(input, context)` to an
`Effect`, so a case supplies the context it wants and runs it. Twilio's
`steps/send-sms.test.ts` is the pattern -- the credentials are an
`Effect.sync` that counts its reads, and the vendor client is the stubbed seam.
What `defineStep` itself does around a handler is covered once, in
`packages/core/src/backend/lib/steps/define-step.test.ts`.

### 5. Test Function (test.ts)

Validates credentials when users click "Test Connection". This one is a Promise
all the way out, because that is the shape the credentials UI calls it with, so
it is where `runVendorCall` enters the runtime and provides the transport.

```typescript
export async function testMyService(credentials: Record<string, string>) {
  const apiKey = credentials.MY_SERVICE_API_KEY;

  if (!apiKey) {
    return { success: false, error: "MY_SERVICE_API_KEY is required" };
  }

  // Format validation first, when the vendor's keys have a known shape: it
  // costs no request and names the problem more precisely than a 401 does.
  if (!apiKey.startsWith("sk_")) {
    return {
      success: false,
      error: "Invalid API key format. Keys should start with 'sk_'",
    };
  }

  // Then a lightweight read-only call through the plugin's client.
  const result = await runVendorCall(
    fetchMyServiceIdentity(apiKey),
    (error) => error
  );

  return result.ok
    ? { success: true }
    : { success: false, error: describeMyServiceFailure(result.failure) };
}
```

### 6. Icon Component (icon.tsx)

Create an SVG icon component:

```typescript
export function MyServiceIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="My Service logo"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>My Service</title>
      {/* Get SVG path from https://simpleicons.org */}
      <path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3L12 2z" />
    </svg>
  );
}
```

Alternatively, use a Lucide icon directly in index.ts:

```typescript
import { Mail } from "lucide-react";

const plugin: IntegrationPlugin = {
  icon: Mail,
  // ...
};
```

## Config Field Types

Available types for action `configFields`:

| Type                | Description                                         | Supports Variables |
| ------------------- | --------------------------------------------------- | ------------------ |
| `template-input`    | Single-line input with `{{NodeName.field}}` support | Yes                |
| `template-textarea` | Multi-line textarea with variable support           | Yes                |
| `text`              | Plain text input                                    | No                 |
| `number`            | Numeric input                                       | No                 |
| `select`            | Dropdown with predefined options                    | No                 |
| `schema-builder`    | Structured output schema builder                    | No                 |
| `group`             | Groups related fields in collapsible section        | N/A                |

### Select Field Example

```typescript
{
  key: "priority",
  label: "Priority",
  type: "select",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  defaultValue: "medium",
}
```

### Conditional Field Example

```typescript
{
  key: "webhookUrl",
  label: "Webhook URL",
  type: "template-input",
  showWhen: { field: "notifyType", equals: "webhook" },
}
```

### Field Group Example

```typescript
{
  type: "group",
  label: "Advanced Options",
  defaultExpanded: false,
  fields: [
    { key: "timeout", label: "Timeout (ms)", type: "number", min: 0 },
    { key: "retries", label: "Retry Count", type: "number", min: 0 },
  ],
}
```

## Critical Rules

### Naming Conventions

- Plugin folder name = plugin `type` (kebab-case): `my-service`
- Step function name = `[actionName]Step` (camelCase): `doSomethingStep`
- Step file name = action slug (kebab-case): `do-something`
- Credential type = `[PluginName]Credentials` (PascalCase): `MyServiceCredentials`
- Test function = `test[PluginName]` (camelCase): `testMyService`
- Icon component = `[PluginName]Icon` (PascalCase): `MyServiceIcon`
- Env vars = `[PLUGIN_NAME]_[FIELD]` (SCREAMING_SNAKE_CASE): `MY_SERVICE_API_KEY`

### Step Requirements

1. The input schema names the config fields the step reads, and every optional
   one is a `Schema.optional` so that a blank field arriving as `undefined` does
   not fail the decode.
2. The output schema describes JSON, and its annotations are what the editor
   shows beside each field.
3. A handler fails with `StepFailure` carrying the message a person reads. There
   is no result type to write: `defineStep` builds the envelope.

## Testing Your Plugin

After creating a plugin:

1. Update static registration files (`packages/plugins/src/index.ts`, the `IntegrationType` union in `packages/shared/src/types/integration.ts`, and `packages/plugins/src/server.ts`, which needs both a `registerStep` line per step and a `registerIntegrationTest` line for the connection test)
2. Run `pnpm run type-check && pnpm run fix` to verify types and fix formatting/linting
3. Run `pnpm run dev` to test in the UI
4. Test the connection using the integration dialog
5. Create a workflow using your action
6. Execute the workflow to verify it works

## Submitting Your Plugin

Once your plugin is tested and working, create a PR:

**Title:** `feat: add [Plugin Name] plugin`

**Body:**

```
## Summary
Adds [Plugin Name] plugin with the following actions:
- [Action 1]: [Brief description]
- [Action 2]: [Brief description]

## Test plan
- [ ] Connection test validates credentials
- [ ] Actions execute successfully in a workflow
- [ ] Error handling works for invalid inputs
```

## Common Patterns

### Multiple Actions

Add multiple actions in the `actions` array:

```typescript
actions: [
  {
    slug: "create-item",
    label: "Create Item",
    // ...
  },
  {
    slug: "update-item",
    label: "Update Item",
    // ...
  },
  {
    slug: "delete-item",
    label: "Delete Item",
    // ...
  },
],
```

Each action needs its own step file in the `steps/` directory.

### Optional Credentials

Some plugins may work without credentials (using defaults or public APIs):

```typescript
const credentials = input.integrationId
  ? await fetchCredentials(input.integrationId)
  : {}; // Empty object if no integrationId

// Handle missing credentials gracefully
const apiKey = credentials.API_KEY || process.env.DEFAULT_API_KEY;
```

### Error Handling

Always return structured errors, never throw:

```typescript
try {
  // API call
} catch (error) {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  };
}
```

## Reference Plugins

Study these existing plugins for patterns:

- `resend/` - Email sending with multiple fields
- `slack/` - Webhook integration
- `linear/` - Issue tracking with select fields
- `twilio/` - SMS sending and templated inputs
