import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@/shared/workflow/action-registry";
import type { StepFunction } from "@/shared/workflow/step-result";

/**
 * A step module as the registry receives it: whatever a step file exports.
 *
 * The exports cannot be typed one by one here, because a step file exports more
 * than its step function (every plugin step also exports an `_integrationType`
 * string). The module is therefore read by the one name the registration
 * records, in `loadStepFunction` below.
 */
type StepModule = Record<string, unknown>;

export type StepImporter = {
  importer: () => Promise<StepModule>;
  stepFunction: string;
  label?: string;
  execute?: (
    input: RuntimeActionExecuteInput
  ) => RuntimeActionResult | Promise<RuntimeActionResult>;
};

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
  importer: StepImporter
): Promise<StepFunction | undefined> {
  const module = await importer.importer();
  const exported = module[importer.stepFunction];

  if (typeof exported !== "function") {
    return;
  }

  // All the module tells us is that this export is callable. That it is a step,
  // and that it copes with the config record the engine builds, is what the
  // registration promises; calling it here is where that promise is taken at
  // its word, once, for every step in the system.
  return (input) => exported(input);
}

const STEP_IMPORTERS: Record<string, StepImporter> = {};

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
  if (!runtimeAction) {
    return;
  }

  return {
    importer: async () => ({}),
    stepFunction: "__runtime_execute__",
    label: runtimeAction.label,
    execute: runtimeAction.execute,
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
  importer: StepImporter
): void {
  STEP_IMPORTERS[actionType] = importer;
}
