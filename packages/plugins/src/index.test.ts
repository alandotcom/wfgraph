import { flattenConfigFields } from "@rova/shared/plugins/action-fields";
import {
  requiredKeysFromSchema,
  requireOutputFieldsFromSchema,
} from "@rova/shared/workflow/output-fields";
import { describe, expect, it } from "vitest";
import { builtInIntegrations } from "#src/index";

/**
 * The two checks `assembleExtensions` runs over every action, run here over the real
 * six.
 *
 * A host finds out about a bad definition when its app starts, which is the right
 * place for a host and the wrong place for this repo: a description missing from one
 * field of one output schema would otherwise reach a reviewer as a green suite and an
 * adopter as a startup crash. Assembly itself lives in `@rova/core`, which this
 * package may not import, so what the cases below run is the same pair of readers
 * assembly runs.
 */
const actions = builtInIntegrations.flatMap((integration) =>
  Object.entries(integration.actions).map(([slug, step]) => ({
    id: `${integration.type}/${slug}`,
    step,
  }))
);

describe("every built-in action", () => {
  it("covers all six integrations", () => {
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

  it.each(actions)(
    "derives the editor's field list for $id",
    ({ id, step }) => {
      expect(
        requireOutputFieldsFromSchema(`Action "${id}"`, step.output)
      ).not.toHaveLength(0);
    }
  );

  // A key the step cannot run without needs a field a builder has to fill in. A
  // field that is merely present is not enough: one left blank produces the config
  // with the key missing, which is a node that fails on every run.
  it.each(actions)(
    "has a required field for every required key of $id",
    ({ step }) => {
      const required = new Set(
        flattenConfigFields(step.configFields)
          .filter((field) => field.required === true)
          .map((field) => field.key)
      );

      expect(
        requiredKeysFromSchema(step.input).filter((key) => !required.has(key))
      ).toEqual([]);
    }
  );
});
