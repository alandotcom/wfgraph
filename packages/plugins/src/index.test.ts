import { checkIntegration } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { builtInIntegrations } from "#src/index";

/**
 * Every check `assembleExtensions` runs over an integration, run here over the real
 * six.
 *
 * A host finds out about a bad definition when its app starts, which is the right
 * place for a host and the wrong place for this repo: a description missing from one
 * field of one output schema would otherwise reach a reviewer as a green suite and an
 * adopter as a startup crash. `checkIntegration` is the function assembly itself
 * calls, exported for exactly this, and it throws naming the action -- so the line
 * below is a check as much as the cases are, and a bad definition fails this file's
 * collection.
 */
const actions = builtInIntegrations.flatMap((integration) =>
  checkIntegration(integration)
);

describe("every built-in integration", () => {
  it("covers all six", () => {
    expect(builtInIntegrations.map((integration) => integration.type)).toEqual([
      "acuity",
      "clerk",
      "linear",
      "resend",
      "slack",
      "twilio",
    ]);
    expect(actions).not.toHaveLength(0);
  });

  // The field list is what the editor offers downstream nodes. Assembly counts it at
  // the root of the output schema, so a schema describing nothing is refused there;
  // this says the same thing per action, where a failure names which one.
  it.each(actions)("offers a field list for $id", ({ outputFields }) => {
    expect(outputFields).not.toHaveLength(0);
  });
});
