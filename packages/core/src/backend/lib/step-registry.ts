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

// The two built-ins that do have a step, registered the way a plugin's steps
// are. They used to be registered from the engine, which made the engine's
// import order load-bearing for whether its own actions existed. The loaders
// stay lazy, so naming them here costs nothing at import time.
registerBuiltInStep(
  "Database Query",
  async () =>
    (await import("#src/backend/lib/steps/database-query")).databaseQueryStep
);

registerBuiltInStep(
  "HTTP Request",
  async () =>
    (await import("#src/backend/lib/steps/http-request")).httpRequestStep
);

/** The built-in action types, in the words the unknown-action message uses. */
export function getSystemActionTypes(): string[] {
  return builtInActions.map((action) => action.id);
}

export function getStepImporter(actionType: string): StepImporter | undefined {
  // An integration passed to `createRovaApp` carries its steps, so the assembled
  // surface is asked first. The map below holds the two built-in steps and the
  // plugins B4 has not ported, which still register on import.
  const step = getExtensions().stepFor(actionType);
  if (step) {
    return { kind: "step", load: () => Promise.resolve(step) };
  }

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
 * Every label comes from the assembled catalog, the built-in four and a host's
 * own actions included, so a second copy beside the step registration cannot
 * disagree with it.
 */
export function getActionLabel(actionType: string): string | undefined {
  return findAction(getExtensions().catalog, actionType)?.label;
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
 * Register one of the two built-in steps, which are still Promise functions.
 *
 * A step written this way declares the config fields it needs as its parameter
 * type, while the engine builds the open record it actually gets, and a
 * function parameter narrows the wrong way for that assignment to hold. So this
 * is where the registration's promise -- that the step copes with the record
 * the engine builds -- is taken at its word.
 *
 * Stage 6b of ADR-0002 took every plugin step to `defineStep`, where the input
 * schema makes the same promise checkable, and this stopped being exported from
 * `@rova/core/plugin` with them: no integration can reach it, and the two call
 * sites left are the ones above. Database Query and HTTP Request each answer a
 * shape `StepResult` has no room for -- rows beside a count, a status beside
 * the data -- so moving them is a decision about what a step may return rather
 * than the mechanical conversion the plugins were.
 */
function registerBuiltInStep(
  actionId: string,
  load: () => Promise<(input: never) => StepResult | Promise<StepResult>>
): void {
  STEP_LOADERS[actionId] = async () => {
    const step = await load();
    return (input) =>
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the two built-in steps; see above
      step(input as never);
  };
}
