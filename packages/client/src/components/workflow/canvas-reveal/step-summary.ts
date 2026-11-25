/**
 * The label and value pairs Browse shows for an ordinary step, built from the
 * step's config and the labels its form uses. A null value is a field the step
 * has not set, which Browse shows as "Not set". A template reference reads as
 * its source's current name, looked up in the workflow's nodes and catalog.
 */

import { compact, partition } from "es-toolkit/array";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { currentTemplateDisplayText } from "@wfgraph/shared/graph/node-display";
import {
  readConfigString,
  readConfigStringOr,
} from "@wfgraph/shared/graph/node-config";
import { readWaitDelayTiming } from "@wfgraph/shared/lifecycle/wait-subscription";
import {
  type ActionConfigField,
  flattenConfigFields,
} from "@wfgraph/shared/plugins/action-fields";
import { matchesShowWhen } from "@wfgraph/shared/types/show-when";
import { isBlank } from "@wfgraph/shared/types/string";
import {
  WAIT_DELAY_TIMING_OPTIONS,
  WAIT_FIELD_LABELS,
  WAIT_GATE_OPTIONS,
  WAIT_MODE_OPTIONS,
  WAIT_TIMEOUT_OPTIONS,
  WAIT_WINDOW_OPTIONS,
  waitOptionLabel,
} from "#src/components/workflow/config/wait-options";
import type { WorkflowNode } from "#src/lib/workflow-graph-types";

/** The workflow a summary names template references against. */
export type SummaryContext = {
  nodes: readonly WorkflowNode[];
  catalog: ExtensionCatalog;
};

export type SummaryRow = {
  /** The config key the row reads, which is also its form field's element id. */
  key: string;
  label: string;
  value: string | null;
  required: boolean;
};

/** A non-blank string config value, or null. */
function setString(
  config: Record<string, unknown>,
  key: string
): string | null {
  const value = readConfigString(config, key);
  return value === undefined || isBlank(value) ? null : value;
}

/**
 * One row per declared field the step currently offers, required fields
 * first. A select shows its option label, a template shows its readable text,
 * and a key-value or provider-backed field shows only that it is set.
 */
export function summarizeActionFields(
  fields: readonly ActionConfigField[],
  config: Record<string, unknown>,
  context: SummaryContext
): SummaryRow[] {
  const rows = flattenConfigFields(fields)
    .filter((field) => matchesShowWhen(config, field.showWhen))
    .map((field): SummaryRow => {
      const raw = config[field.key];
      const text =
        typeof raw === "number" ? String(raw) : setString(config, field.key);
      let value: string | null = null;
      if (text !== null) {
        if (field.type === "select") {
          value =
            field.options?.find((option) => option.value === text)?.label ??
            text;
        } else if (
          field.type === "key-value" ||
          field.type === "provider-fields"
        ) {
          value = "Set";
        } else {
          value = currentTemplateDisplayText(
            text,
            context.nodes,
            context.catalog
          );
        }
      }
      return {
        key: field.key,
        label: field.label,
        value,
        required: field.required === true,
      };
    });
  const [required, optional] = partition(rows, (row) => row.required);
  return [...required, ...optional];
}

type WaitFieldKey = keyof typeof WAIT_FIELD_LABELS;

function waitRow(key: WaitFieldKey, value: string | null): SummaryRow {
  return { key, label: WAIT_FIELD_LABELS[key], value, required: false };
}

/**
 * A Wait step's timing or timeout settings, in the words its form uses. The
 * Events an event-mode Wait resumes on are summarized separately.
 */
export function summarizeWait(
  config: Record<string, unknown>,
  context: SummaryContext
): SummaryRow[] {
  const mode = readConfigStringOr(config, "waitMode", "delay");
  const modeRow = waitRow("waitMode", waitOptionLabel(WAIT_MODE_OPTIONS, mode));
  if (mode === "event") {
    return [
      modeRow,
      waitRow("waitTimeout", setString(config, "waitTimeout")),
      waitRow(
        "waitTimeoutBehavior",
        waitOptionLabel(
          WAIT_TIMEOUT_OPTIONS,
          readConfigStringOr(config, "waitTimeoutBehavior", "continue")
        )
      ),
    ];
  }
  const timing = readWaitDelayTiming(config);
  const gateMode = readConfigStringOr(config, "waitGateMode", "off");
  const windowMode = readConfigStringOr(config, "waitAllowedHoursMode", "off");
  const start = setString(config, "waitAllowedStartTime");
  const end = setString(config, "waitAllowedEndTime");
  const windowLabel = waitOptionLabel(WAIT_WINDOW_OPTIONS, windowMode);
  const timingRows =
    timing === "duration"
      ? [waitRow("waitDuration", textOf(config, "waitDuration", context))]
      : compact([
          waitRow("waitUntil", textOf(config, "waitUntil", context)),
          setString(config, "waitOffset") === null
            ? undefined
            : waitRow("waitOffset", textOf(config, "waitOffset", context)),
        ]);
  return [
    modeRow,
    waitRow(
      "waitDelayTimingMode",
      waitOptionLabel(WAIT_DELAY_TIMING_OPTIONS, timing)
    ),
    ...timingRows,
    waitRow("waitGateMode", waitOptionLabel(WAIT_GATE_OPTIONS, gateMode)),
    ...(gateMode === "max_lateness"
      ? [waitRow("waitMaxLateness", textOf(config, "waitMaxLateness", context))]
      : []),
    waitRow(
      "waitAllowedHoursMode",
      windowMode === "daily_window"
        ? `${start ?? "Not set"} to ${end ?? "Not set"}`
        : windowLabel
    ),
    waitRow("waitTimezone", readConfigStringOr(config, "waitTimezone", "UTC")),
  ];
}

function textOf(
  config: Record<string, unknown>,
  key: string,
  context: SummaryContext
): string | null {
  const value = setString(config, key);
  return value === null
    ? null
    : currentTemplateDisplayText(value, context.nodes, context.catalog);
}
