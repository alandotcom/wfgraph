import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@/shared/workflow/action-registry";
import type { StepFunction } from "@/shared/workflow/step-result";

/**
 * A step module as the registry receives it: whatever a step file exports.
 *
 * Typing the exports as step functions would reject every registration. Each
 * step declares a narrow input type for the config fields it needs, while
 * `StepFunction` accepts the open record the engine builds, and a function
 * parameter narrows the wrong way for that assignment to hold. The module is
 * therefore read by the one name the registration records, and
 * `loadStepFunction` below is where the value becomes a typed step.
 */
type StepModule = Record<string, unknown>;

/**
 * How the engine reaches an action's implementation.
 *
 * A plugin step is a named export of a module loaded on demand. A runtime action
 * carries its function directly. These were one shape with optional fields,
 * which meant a runtime action wore a module importer's clothes: a fake export
 * name and an importer returning `{}`. An action registered as metadata alone,
 * which is what the browser holds, then reached the module path and reported
 * that a plugin was missing an export it never had.
 */
export type StepImporter =
  | {
      kind: "module";
      importer: () => Promise<StepModule>;
      stepFunction: string;
      label?: string;
    }
  | {
      kind: "runtime";
      execute: (
        input: RuntimeActionExecuteInput
      ) => RuntimeActionResult | Promise<RuntimeActionResult>;
      label?: string;
    };

/** The module half, for the loader and the built-in actions. */
export type ModuleStepImporter = Extract<StepImporter, { kind: "module" }>;

/**
 * Resolve a registration to the step function it names.
 *
 * This is the seam where a dynamically imported export becomes a callable step,
 * and the only place in the system that claims a value honours the step
 * contract. The export name is data (it comes from `registerStepImporter`), so
 * the compiler cannot check the lookup; stating the contract here once means
 * every caller downstream works with a typed `StepResult` and none of them has
 * to inspect the returned value to find out what it got.
 *
 * Returns undefined when the module has no such export, which is a plugin whose
 * registration and exported function name disagree.
 */
export async function loadStepFunction(
  importer: ModuleStepImporter
): Promise<StepFunction | undefined> {
  const module = await importer.importer();
  const exported = module[importer.stepFunction];

  if (typeof exported !== "function") {
    return undefined;
  }

  // All the module tells us is that this export is callable. That it is a step,
  // and that it copes with the config record the engine builds, is what the
  // registration promises; calling it here is where that promise is taken at
  // its word, once, for every step in the system.
  return (input) => exported(input);
}

const STEP_IMPORTERS: Record<string, ModuleStepImporter> = {};

const SYSTEM_ACTION_LABELS: Record<string, string> = {
  Condition: "Condition",
  "Database Query": "Database Query",
  "HTTP Request": "HTTP Request",
  Wait: "Wait",
};

export function getStepImporter(actionType: string): StepImporter | undefined {
  const importer = STEP_IMPORTERS[actionType];
  if (importer) {
    return importer;
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

export function getActionLabel(actionType: string): string | undefined {
  if (SYSTEM_ACTION_LABELS[actionType]) {
    return SYSTEM_ACTION_LABELS[actionType];
  }

  const runtimeAction = getRuntimeAction(actionType);
  if (runtimeAction) {
    return runtimeAction.label;
  }

  return STEP_IMPORTERS[actionType]?.label;
}

export function registerStepImporter(
  actionType: string,
  importer: Omit<ModuleStepImporter, "kind">
): void {
  STEP_IMPORTERS[actionType] = { kind: "module", ...importer };
}
