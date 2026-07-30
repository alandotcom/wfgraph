/**
 * How the engine reaches an action's implementation.
 *
 * Three kinds of action exist and the lookup below is where they meet. An
 * integration's action carries its step in the definition a host passed to
 * `createRovaApp`, so the assembled surface answers for it. A host's own action
 * carries a function it wrote. The two the engine ships itself -- Database Query
 * and HTTP Request -- are Promise functions loaded on demand, because each
 * answers a shape the `StepResult` envelope has no room for and moving them is a
 * decision about what a step may return rather than a mechanical port.
 *
 * The kinds are separate arms rather than one shape with optional fields, which
 * is what they used to be: a runtime action then wore a module importer's
 * clothes, and an action registered as metadata alone reached the module path and
 * reported that a plugin was missing an export it never had.
 */

import { findAction } from "@rova/shared/extensions/catalog";
import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@rova/shared/workflow/action-registry";
import type {
  StepFunction,
  StepResult,
} from "@rova/shared/workflow/step-result";
import { builtInActions } from "#src/backend/lib/extensions/built-ins";
import { getExtensions } from "#src/backend/lib/extensions/current";

export type StepImporter =
  | { kind: "step"; load: () => Promise<StepFunction> }
  | {
      kind: "runtime";
      execute: (
        input: RuntimeActionExecuteInput
      ) => RuntimeActionResult | Promise<RuntimeActionResult>;
      label?: string;
    };

/**
 * The two built-in steps, behind their imports.
 *
 * A step written this way declares the config fields it needs as its parameter
 * type, while the engine builds the open record it actually gets, and a function
 * parameter narrows the wrong way for that assignment to hold. So this map is
 * where the promise -- that each copes with the record the engine builds -- is
 * taken at its word, and the cast below is the whole of it. An integration's step
 * needs none of this: its input schema makes the same promise checkable.
 */
const BUILT_IN_STEPS: Record<
  string,
  () => Promise<(input: never) => StepResult | Promise<StepResult>>
> = {
  "Database Query": async () =>
    (await import("#src/backend/lib/steps/database-query")).databaseQueryStep,
  "HTTP Request": async () =>
    (await import("#src/backend/lib/steps/http-request")).httpRequestStep,
};

/** The built-in action types, in the words the unknown-action message uses. */
export function getSystemActionTypes(): string[] {
  return builtInActions.map((action) => action.id);
}

export function getStepImporter(actionType: string): StepImporter | undefined {
  const step = getExtensions().stepFor(actionType);
  if (step) {
    return { kind: "step", load: () => Promise.resolve(step) };
  }

  if (Object.hasOwn(BUILT_IN_STEPS, actionType)) {
    const load = BUILT_IN_STEPS[actionType];

    return {
      kind: "step",
      load: async () => {
        const builtIn = await load();

        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the two built-in steps; see above
        return (input) => builtIn(input as never);
      },
    };
  }

  const runtimeAction = getRuntimeAction(actionType);
  // An entry with no `execute` is metadata registered for the editor to draw,
  // which the browser holds and the server never should. It has no
  // implementation, so it is not an importer.
  if (!runtimeAction?.execute) {
    return undefined;
  }

  return {
    kind: "runtime",
    execute: runtimeAction.execute,
    label: runtimeAction.label,
  };
}

/**
 * The name a run log gives an action node that has no label of its own.
 *
 * Every label comes from the assembled catalog, the built-in four and a host's
 * own actions included, so a second copy beside the step registration cannot
 * disagree with it.
 */
export function getActionLabel(actionType: string): string | undefined {
  return findAction(getExtensions().catalog, actionType)?.label;
}
