import * as stylex from "@stylexjs/stylex";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DateTimeInput } from "@astryxdesign/core/DateTimeInput";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { useState } from "react";
import { toISODateTimeString } from "#src/lib/astryx-input-values";
import {
  formValuesFromPayload,
  parseTestPayload,
  payloadFromFormValues,
  type TestPayloadField,
  type TestPayloadFormValues,
  testPayloadFields,
} from "#src/lib/test-payload";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import {
  findEvent,
  type ExtensionCatalog,
} from "@wfgraph/shared/extensions/catalog";
import {
  type TestPayloads,
  testPayloadFor,
} from "@wfgraph/shared/lifecycle/test-payloads";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";
import type { OverlayComponentProps } from "./types";

/**
 * The value the Event select carries for a run that stands in for no Event. An
 * Event name is never empty, so no real choice collides with it.
 */
const NO_EVENT = "";

export type TestRunRequest = {
  eventName?: string;
  input: JsonObject;
};

type TestRunOverlayProps = OverlayComponentProps<{
  /** The workflow's Start Events, in the order the Lifecycle panel lists them. */
  startEvents: readonly string[];
  /** Whether a run naming no Event is one this workflow takes at all. */
  allowManualStart: boolean;
  /**
   * Whether the graph splits on the Event a run is on. Such a graph refuses an
   * Event-less run, so the overlay says so before the request rather than after.
   */
  hasEventSplit: boolean;
  /** The samples the workflow kept, one per Event plus the Event-less one. */
  savedPayloads: TestPayloads;
  onRun: (request: TestRunRequest) => void;
}>;

/** What the Event select shows for one Start Event: its label, then its name. */
function eventLabel(catalog: ExtensionCatalog, eventName: string): string {
  return findEvent(catalog, eventName)?.label ?? eventName;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: TestPayloadField;
  value: string;
  onChange: (next: string) => void;
}) {
  if (field.control === "checkbox") {
    return (
      <CheckboxInput
        isLabelHidden
        label={field.path}
        onChange={(checked) => onChange(checked ? "true" : "false")}
        value={value === "true"}
      />
    );
  }

  if (field.control === "select") {
    return (
      <Selector
        isLabelHidden
        label={field.path}
        onChange={onChange}
        options={(field.options ?? []).map((option) => ({
          value: option,
          label: option,
        }))}
        placement="below"
        placeholder="Choose a value"
        value={value}
        width="100%"
      />
    );
  }

  if (field.control === "number") {
    return (
      <NumberInput
        hasClear
        isLabelHidden
        label={field.path}
        onChange={(next) => onChange(next === null ? "" : String(next))}
        value={value.trim() ? Number(value) : null}
        width="100%"
      />
    );
  }

  if (field.control === "datetime") {
    return (
      <DateTimeInput
        isLabelHidden
        label={field.path}
        onChange={(next) => onChange(next ?? "")}
        value={toISODateTimeString(value || undefined)}
        width="100%"
      />
    );
  }

  return (
    <TextInput
      isLabelHidden
      label={field.path}
      onChange={onChange}
      value={value}
      width="100%"
    />
  );
}

function PayloadForm({
  fields,
  values,
  onChange,
}: {
  fields: readonly TestPayloadField[];
  values: TestPayloadFormValues;
  onChange: (path: string, next: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <Text color="secondary">
        This Event declares no payload field the form can draw. Use the JSON tab
        to write the payload.
      </Text>
    );
  }

  return (
    <VStack gap={4}>
      {fields.map((field) => (
        <VStack gap={2} key={field.path}>
          <Text type="code">
            {field.path}
            {field.optional && (
              <Text color="secondary" type="supporting">
                {" "}
                optional
              </Text>
            )}
          </Text>
          <FieldControl
            field={field}
            onChange={(next) => onChange(field.path, next)}
            value={values[field.path] ?? ""}
          />
          {field.description && (
            <Text color="secondary" type="supporting">
              {field.description}
            </Text>
          )}
        </VStack>
      ))}
    </VStack>
  );
}

/**
 * The data a test run carries, gathered before the run starts.
 *
 * Two things leave here: the payload, which every template downstream addresses,
 * and the Event the run stands in for, which is what an Event Split routes on. A
 * run given neither reaches the first node that needs one and stops there, so
 * this is the screen that keeps a test run from being a different thing than the
 * run it is testing.
 */
export function TestRunOverlay({
  overlayId,
  startEvents,
  allowManualStart,
  hasEventSplit,
  savedPayloads,
  onRun,
}: TestRunOverlayProps) {
  const catalog = useExtensionCatalog();
  const { closeAll } = useOverlay();

  // The first Start Event, since one of them is the ordinary shape. A workflow
  // with none can only be the Event-less manual start.
  const [selectedEvent, setSelectedEvent] = useState<string>(
    startEvents[0] ?? NO_EVENT
  );
  const [pane, setPane] = useState<"form" | "json">("form");

  const eventName = selectedEvent === NO_EVENT ? undefined : selectedEvent;
  const savedPayload = testPayloadFor(savedPayloads, eventName);

  const fields = testPayloadFields(
    eventName ? findEvent(catalog, eventName) : undefined
  );

  const [values, setValues] = useState<TestPayloadFormValues>(() =>
    formValuesFromPayload(fields, savedPayload)
  );
  const [jsonText, setJsonText] = useState(() =>
    JSON.stringify(savedPayload ?? {}, null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  // The payload the JSON pane holds, which is also what the form writes into: a
  // path the form has no field for survives the round trip that way.
  const [basePayload, setBasePayload] = useState<JsonObject>(
    () => savedPayload ?? {}
  );

  const chooseEvent = (next: string) => {
    setSelectedEvent(next);
    const chosen = next === NO_EVENT ? undefined : next;
    const payload = testPayloadFor(savedPayloads, chosen) ?? {};
    const nextFields = testPayloadFields(
      chosen ? findEvent(catalog, chosen) : undefined
    );

    setValues(formValuesFromPayload(nextFields, payload));
    setJsonText(JSON.stringify(payload, null, 2));
    setBasePayload(payload);
    setJsonError(null);
  };

  /** The form's values as a payload, on top of whatever the JSON pane holds. */
  const currentPayload = () =>
    payloadFromFormValues(fields, values, basePayload);

  const showJson = () => {
    setJsonText(JSON.stringify(currentPayload(), null, 2));
    setJsonError(null);
    setPane("json");
  };

  const showForm = () => {
    const parsed = parseTestPayload(jsonText);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }

    setValues(formValuesFromPayload(fields, parsed.payload));
    setBasePayload(parsed.payload);
    setJsonError(null);
    setPane("form");
  };

  const eventIsRequired = hasEventSplit;
  const canRun = !eventIsRequired || eventName !== undefined;

  const handleRun = () => {
    if (pane === "json") {
      const parsed = parseTestPayload(jsonText);
      if (!parsed.ok) {
        setJsonError(parsed.error);
        return;
      }

      onRun({ ...(eventName ? { eventName } : {}), input: parsed.payload });
      closeAll();
      return;
    }

    onRun({ ...(eventName ? { eventName } : {}), input: currentPayload() });
    closeAll();
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "secondary", onClick: closeAll },
        { label: "Run", onClick: handleRun, disabled: !canRun },
      ]}
      description="A test run carries the payload an Event would have sent, so every template downstream resolves the way it will in production."
      overlayId={overlayId}
      title="Test run"
    >
      <VStack gap={6}>
        <Selector
          description={
            hasEventSplit
              ? "This workflow splits on the Event a run is on, so a run has to name one."
              : undefined
          }
          label="Which Event does this run stand in for?"
          onChange={chooseEvent}
          options={[
            ...startEvents.map((name) => ({
              value: name,
              label: eventLabel(catalog, name),
            })),
            ...(allowManualStart
              ? [
                  {
                    value: NO_EVENT,
                    label: "No Event (manual start)",
                    isDisabled: hasEventSplit,
                  },
                ]
              : []),
          ]}
          placement="below"
          placeholder="Choose an Event"
          value={selectedEvent}
          width="100%"
        />

        <VStack gap={3}>
          <Text type="label">Payload</Text>
          <SegmentedControl
            label="Payload editor"
            onChange={(next) => (next === "form" ? showForm() : showJson())}
            size="sm"
            value={pane}
          >
            <SegmentedControlItem label="Form" value="form" />
            <SegmentedControlItem label="JSON" value="json" />
          </SegmentedControl>

          {pane === "form" ? (
            <PayloadForm
              fields={fields}
              onChange={(path, next) =>
                setValues((current) => ({ ...current, [path]: next }))
              }
              values={values}
            />
          ) : (
            <TextArea
              label="Payload JSON"
              onChange={(next) => {
                setJsonText(next);
                setJsonError(null);
              }}
              rows={12}
              value={jsonText}
              width="100%"
            />
          )}

          {jsonError && (
            <Text type="supporting" xstyle={styles.errorText}>
              {jsonError}
            </Text>
          )}
        </VStack>
      </VStack>
    </Overlay>
  );
}

const styles = stylex.create({
  errorText: {
    color: colorVars["--color-text-red"],
  },
});
