import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@/shared/workflow/action-registry";

type StepModule = Record<string, unknown>;

export type StepImporter = {
  importer: () => Promise<StepModule>;
  stepFunction: string;
  label?: string;
  execute?: (
    input: RuntimeActionExecuteInput
  ) => RuntimeActionResult | Promise<RuntimeActionResult>;
};

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
