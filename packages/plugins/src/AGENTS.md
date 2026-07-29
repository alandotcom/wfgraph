# Plugin Development Guide for AI Agents

This document guides AI agents through creating and modifying workflow builder plugins.

## Quick Start

Plugins are now registered via manual static files (no scaffold/discovery scripts).

When creating or modifying a plugin, update these files manually:

1. `plugins/index.ts` - add/remove plugin import
2. `shared/types/integration.ts` - update `IntegrationType` union
3. `backend/lib/step-registry.ts` - add/remove action step importers and labels
4. `client/lib/output-display-configs.ts` - update if action has image/video/url output config

## Plugin Architecture

Each plugin lives in `plugins/[plugin-name]/` with this structure:

```
plugins/[plugin-name]/
  index.ts          # Plugin definition (actions, form fields, metadata)
  credentials.ts    # Credential type definition
  client.ts         # The vendor's HTTP API, over fetch
  client.test.ts    # What the client puts on the wire
  icon.tsx          # SVG icon component
  test.ts           # Connection test function
  steps/
    [action].ts     # Server-side step functions (one per action)
```

**Call vendors through `vendor-http.ts`, not their SDK.** `callVendor` takes a
request spec and answers an `Effect` holding the decoded body, over Effect's own
`HttpClient`. It owns the ten-second per-attempt timeout, the retry schedule, the
JSON read, the decode, and the three failures every vendor call can end in:
`VendorUnreachable` (nothing answered), `VendorRejected` (it answered and said
no, carrying its own error body), and `VendorUnreadable` (a success status whose
body is not the documented shape).

A `client.ts` is the adapter above that: the auth header, the endpoints, the
vendor's error-envelope schema, and a function turning a `VendorError` into the
`{ ok, failure }` shape its steps still read. `runVendorCall` is the Promise seam
that runs the effect and provides the transport; it and the per-vendor result
shapes go away at stage 6 of ADR-0002, when a step handler becomes an Effect.

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

### 3. Step Function (steps/[action].ts)

Step functions follow a two-layer pattern:

```typescript
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import type { MyServiceCredentials } from "../credentials";

// Result type - use discriminated union
type DoSomethingResult =
  { success: true; id: string } | { success: false; error: string };

// Core input - fields from configFields
export type DoSomethingCoreInput = {
  inputField: string;
  optionalField?: string;
};

// Full input - includes integrationId and step context
export type DoSomethingInput = StepInput &
  DoSomethingCoreInput & {
    integrationId?: string;
  };

/**
 * Core logic - receives credentials as parameter
 * This separation keeps integration handling outside the API call logic
 */
async function stepHandler(
  input: DoSomethingCoreInput,
  credentials: MyServiceCredentials
): Promise<DoSomethingResult> {
  const apiKey = credentials.MY_SERVICE_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "MY_SERVICE_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  // The HTTP call lives in the plugin's own client.ts, built on requestVendor.
  // Steps stay about what to send and what the answer means.
  const result = await createMyServiceItem(apiKey, { field: input.inputField });

  if (!result.ok) {
    return {
      success: false,
      error: `Failed: ${describeMyServiceFailure(result.failure)}`,
    };
  }

  return { success: true, id: result.data.id };
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function doSomethingStep(
  input: DoSomethingInput
): Promise<DoSomethingResult> {
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
```

The step file exports the function and nothing else. What ties the action ID to
that export lives in `packages/plugins/src/server.ts`, which the server imports
for its side effects. That file also registers the connection test, and both
registrations are lazy on purpose: a step implementation and a connection test
each reach a vendor over the network, and neither should enter the process until
something calls it.

```typescript
registerStepImporter("my-service/do-something", {
  importer: () => import("#src/my-service/steps/do-something"),
  stepFunction: "doSomethingStep",
  label: "Do Something",
});
```

### 4. Test Function (test.ts)

Validates credentials when users click "Test Connection":

```typescript
export async function testMyService(credentials: Record<string, string>) {
  try {
    const apiKey = credentials.MY_SERVICE_API_KEY;

    if (!apiKey) {
      return { success: false, error: "MY_SERVICE_API_KEY is required" };
    }

    // Option 1: Format validation (if API keys have known format)
    if (!apiKey.startsWith("sk_")) {
      return {
        success: false,
        error: "Invalid API key format. Keys should start with 'sk_'",
      };
    }

    // Option 2: Make a lightweight read-only call through the plugin's client
    const result = await fetchMyServiceIdentity(apiKey);
    if (!result.ok) {
      return {
        success: false,
        error: describeMyServiceFailure(result.failure),
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

### 5. Icon Component (icon.tsx)

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

### Step Function Requirements

1. Core input type should match the configFields keys
2. Full input type extends `StepInput` and includes `integrationId`

### Result Types

Use discriminated unions for result types:

```typescript
type ActionResult =
  | { success: true; id: string; data?: SomeData }
  | { success: false; error: string };
```

## Testing Your Plugin

After creating a plugin:

1. Update static registration files (`packages/plugins/src/index.ts`, the `IntegrationType` union in `packages/shared/src/types/integration.ts`, and `packages/plugins/src/server.ts`, which needs both a `registerStepImporter` line per step and a `registerIntegrationTest` line for the connection test)
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
