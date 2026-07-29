import { findActionById } from "@rova/shared/plugins/registry";
import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@rova/shared/workflow/action-registry";
import type {
  StepFunction,
  StepResult,
} from "@rova/shared/workflow/step-result";
import type { StepDefinition } from "#src/backend/lib/steps/define-step";

/**
 * How the engine reaches an action's implementation.
 *
 * A plugin step is loaded on demand, because a step implementation pulls vendor
 * code that should not enter the process until something calls it. A runtime
 * action carries its function directly. These were one shape with optional
 * fields, which meant a runtime action wore a module importer's clothes: a fake
 * export name and an importer returning `{}`. An action registered as metadata
 * alone, which is what the browser holds, then reached the module path and
 * reported that a plugin was missing an export it never had.
 */
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
 * The registered steps, held in module state.
 *
 * Stage 7 of ADR-0002 brings the run engine into the app's runtime, and this
 * map becomes a service it reads from. Until then the engine dispatches from
 * outside any runtime, so the registrations have to be reachable from outside
 * one too.
 */
const STEP_LOADERS: Record<string, () => Promise<StepFunction>> = {};

/**
 * The built-in actions, which are not any plugin's.
 *
 * Every one of them is named here and nowhere else: the label a run log gives
 * the node, and the list an unknown action type is told about. Condition and
 * Wait have no step below, because the engine handles both itself; it evaluates
 * the expression, and the wait suspends the run through the durable runtime.
 */
const SYSTEM_ACTION_LABELS: Record<string, string> = {
  Condition: "Condition",
  "Database Query": "Database Query",
  "HTTP Request": "HTTP Request",
  Wait: "Wait",
};

// The two built-ins that do have a step, registered the way a plugin's steps
// are. They used to be registered from the engine, which made the engine's
// import order load-bearing for whether its own actions existed. The loaders
// stay lazy, so naming them here costs nothing at import time.
registerStepFunction(
  "Database Query",
  async () =>
    (await import("#src/backend/lib/steps/database-query")).databaseQueryStep
);

registerStepFunction(
  "HTTP Request",
  async () =>
    (await import("#src/backend/lib/steps/http-request")).httpRequestStep
);

/** The built-in action types, in the words the unknown-action message uses. */
export function getSystemActionTypes(): string[] {
  return Object.keys(SYSTEM_ACTION_LABELS);
}

export function getStepImporter(actionType: string): StepImporter | undefined {
  if (Object.hasOwn(STEP_LOADERS, actionType)) {
    return { kind: "step", load: STEP_LOADERS[actionType] };
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
 * A plugin's label lives in the action metadata the editor renders, which the
 * server holds too, so that is where this reads it: a second copy beside the
 * step registration could only disagree with the first, and nothing would
 * notice which one a reader got.
 */
export function getActionLabel(actionType: string): string | undefined {
  if (SYSTEM_ACTION_LABELS[actionType]) {
    return SYSTEM_ACTION_LABELS[actionType];
  }

  const runtimeAction = getRuntimeAction(actionType);
  if (runtimeAction) {
    return runtimeAction.label;
  }

  return findActionById(actionType)?.label;
}

/**
 * Register a step under the action id it implements.
 *
 * The id is checked against the one the step declares, so a registration and
 * its step cannot name different actions. What the loader resolves to is a
 * value rather than a name to look up, so a renamed export is a compile error
 * rather than an action that reports itself missing at run time.
 *
 * `NoInfer` is what makes the first of those true. Without it `Id` is inferred
 * from both arguments at once, so a mismatched pair widens to the union of the
 * two ids and type-checks, which is the opposite of what this signature is for.
 * The key is the only thing that names `Id`; the loader is then checked against
 * it.
 */
export function registerStep<Id extends string>(
  actionId: Id,
  load: () => Promise<StepDefinition<NoInfer<Id>>>
): void {
  STEP_LOADERS[actionId] = async () => (await load()).run;
}

/**
 * Register a step that is still a Promise function.
 *
 * The un-migrated half of stage 6 of ADR-0002. A step written this way declares
 * the config fields it needs as its parameter type, while the engine builds the
 * open record it actually gets, and a function parameter narrows the wrong way
 * for that assignment to hold. So this is where the registration's promise --
 * that the step copes with the record the engine builds -- is taken at its
 * word, once, for every step still written this way. It used to be taken at its
 * word for all of them, in `loadStepFunction`, along with the claim that a
 * module exported a function under a name recorded as data.
 *
 * Stage 6b takes the last of these to `defineStep`, where the schema makes the
 * same promise checkable, and this function goes with them.
 */
export function registerStepFunction(
  actionId: string,
  load: () => Promise<(input: never) => StepResult | Promise<StepResult>>
): void {
  STEP_LOADERS[actionId] = async () => {
    const step = await load();
    return (input) =>
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the un-migrated half of stage 6; see above
      step(input as never);
  };
}
