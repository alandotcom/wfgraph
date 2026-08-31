/**
 * A config field's `connectionDefaultKey` names a Connection value the editor
 * can actually draw.
 *
 * Neither mistake shows up at runtime: an undeclared key leaves the placeholder
 * quietly falling back to the catalog's example, and a password key would draw
 * the mask the browser is served in place of a secret. The key is typed to the
 * integration's own credentials, so a TypeScript author meets the first at the
 * keyboard; `checkIntegration` still refuses both, for a host writing JavaScript
 * or casting past the type.
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkIntegration,
  defineIntegration,
} from "#src/backend/extensions/define-integration";
import type { ActionConfigFieldFor } from "#src/backend/extensions/steps/define-step";
import type { CredentialFields } from "@wfgraph/shared/extensions/catalog";

const credentials = {
  EXAMPLE_API_KEY: { label: "API Key", type: "password" },
  EXAMPLE_FROM: { label: "Default Sender", type: "text" },
} satisfies CredentialFields;

type ExampleInput = { readonly from?: string };
type CredentialKey = keyof typeof credentials;

function fromFieldNaming(
  connectionDefaultKey: CredentialKey
): ActionConfigFieldFor<ExampleInput, CredentialKey> {
  return {
    key: "from",
    label: "From",
    type: "template-input",
    connectionDefaultKey,
  };
}

/** Past the type, which is the only way a JavaScript host reaches the check. */
function unsafeConnectionDefaultKey(
  key: string
): ActionConfigFieldFor<ExampleInput, CredentialKey> {
  return {
    key: "from",
    label: "From",
    type: "template-input",
    connectionDefaultKey: key,
  } as unknown as ActionConfigFieldFor<ExampleInput, CredentialKey>;
}

function integrationWith(
  field: ActionConfigFieldFor<ExampleInput, CredentialKey>
) {
  return defineIntegration({
    type: "example",
    label: "Example",
    description: "Test integration",
    credentials,
    actions: {
      send: {
        label: "Send",
        description: "Sends",
        input: Schema.Struct({ from: Schema.optionalKey(Schema.String) }),
        output: Schema.Struct({
          id: Schema.String.annotate({ description: "Id" }),
        }),
        configFields: [field],
        handler: () => ({ id: "1" }),
      },
    },
  });
}

describe("a config field's connection default", () => {
  it("accepts a field naming a value the integration declares", () => {
    expect(() =>
      checkIntegration(integrationWith(fromFieldNaming("EXAMPLE_FROM")))
    ).not.toThrow();
  });

  it("refuses a key the integration never declared", () => {
    expect(() =>
      checkIntegration(
        integrationWith(unsafeConnectionDefaultKey("EXAMPLE_SENDER"))
      )
    ).toThrow(/does not declare/u);
  });

  // Not expressible in the type, because `CredentialsOf` keeps the keys and
  // drops each field's `type`.
  it("refuses a key the integration declares as a password", () => {
    expect(() =>
      checkIntegration(integrationWith(fromFieldNaming("EXAMPLE_API_KEY")))
    ).toThrow(/password field/u);
  });

  it("holds the key to the integration's own credentials at compile time", () => {
    const field = {
      key: "from",
      label: "From",
      type: "template-input",
      // @ts-expect-error EXAMPLE_SENDER is not one of this integration's credentials.
      connectionDefaultKey: "EXAMPLE_SENDER",
    } satisfies ActionConfigFieldFor<ExampleInput, CredentialKey>;

    expect(field.key).toBe("from");
  });
});
