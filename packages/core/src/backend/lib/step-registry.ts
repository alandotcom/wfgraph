/**
 * How the engine reaches an action's implementation.
 *
 * Everything a host passed to `createRovaApp` carries its own implementation into
 * the assembled surface -- an integration's actions through `defineStep`, a host's
 * own through `createAction` -- so the lookup is that surface and the two actions
 * the engine ships itself. Database Query and HTTP Request stay Promise functions
 * here because each answers a shape the `StepResult` envelope has no room for, and
 * moving them is a decision about what a step may return rather than a mechanical
 * port.
 */

import { findAction } from "@rova/shared/extensions/catalog";
import type {
  StepFunction,
  StepResult,
} from "@rova/shared/workflow/step-result";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import { getExtensions } from "#src/backend/lib/extensions/current";

/**
 * A built-in step, loaded and handed the record the engine built.
 *
 * A step written this way declares the config fields it needs as its parameter
 * type, while the engine builds the open record it actually gets, and a function
 * parameter narrows the wrong way for that assignment to hold. So this is where
 * the promise -- that each of the two copes with the record the engine builds --
 * is taken at its word, and the cast below is the whole of it. An integration's
 * step needs none of this: its input schema makes the same promise checkable.
 */
async function runBuiltIn(
  input: Record<string, unknown>,
  load: () => Promise<(input: never) => StepResult | Promise<StepResult>>
): Promise<StepResult> {
  const step = await load();

  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return await step(input as never);
}

/**
 * The two the engine ships, each holding its own import so that a process running
 * neither action loads neither module.
 */
const BUILT_IN_STEPS: Record<string, StepFunction | undefined> = {
  "Database Query": (input) =>
    runBuiltIn(
      input,
      async () =>
        (await import("#src/backend/lib/steps/database-query"))
          .databaseQueryStep
    ),
  "HTTP Request": (input) =>
    runBuiltIn(
      input,
      async () =>
        (await import("#src/backend/lib/steps/http-request")).httpRequestStep
    ),
};

/** The built-in action types, in the words the unknown-action message uses. */
export function getSystemActionTypes(): string[] {
  return builtInActions.map((action) => action.id);
}

export function getStepFunction(actionType: string): StepFunction | undefined {
  return getExtensions().stepFor(actionType) ?? BUILT_IN_STEPS[actionType];
}

/**
 * The name a run log gives an action node that has no label of its own.
 *
 * Every label comes from the assembled catalog, the built-in four and a host's
 * own actions included, so a second copy beside the implementation cannot
 * disagree with it.
 */
export function getActionLabel(actionType: string): string | undefined {
  return findAction(getExtensions().catalog, actionType)?.label;
}
