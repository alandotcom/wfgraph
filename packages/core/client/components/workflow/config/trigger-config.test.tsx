import { describe, expect, it } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { TriggerConfig } from "@/components/workflow/config/trigger-config";

const ROUTING_RULES_BUTTON_REGEX = /routing rules/i;
const SAMPLE_PAYLOAD_BUTTON_REGEX = /sample payload/i;

function ControlledTriggerConfig({
  initialConfig,
  onConfigChange,
}: {
  initialConfig: Record<string, unknown>;
  onConfigChange?: (config: Record<string, unknown>) => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);

  return (
    <TriggerConfig
      config={config}
      disabled={false}
      onUpdateConfig={(patch) =>
        setConfig((prev) => {
          const next = { ...prev, ...patch };
          onConfigChange?.(next);
          return next;
        })
      }
      workflowId="wf_123"
    />
  );
}

describe("TriggerConfig webhook sections", () => {
  it("shows endpoint and schema by default while keeping routing collapsed", () => {
    const view = render(
      <ControlledTriggerConfig
        initialConfig={{
          triggerType: "Webhook",
          webhookSchema: JSON.stringify([
            { name: "event", type: "string" },
            {
              name: "data",
              type: "object",
              fields: [{ name: "id", type: "string" }],
            },
          ]),
          webhookEventPath: "event",
          webhookCreateEvents: "appointment.create",
        }}
      />
    );

    const routingButton = view.getByRole("button", {
      name: ROUTING_RULES_BUTTON_REGEX,
    });

    expect(view.getByLabelText("Webhook URL")).toBeTruthy();
    expect(routingButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(routingButton);

    expect(routingButton.getAttribute("aria-expanded")).toBe("true");

    expect(
      view.getByLabelText("Which schema field contains the event value?")
    ).toBeTruthy();
  });

  it("auto-expands routing section when configuration warnings exist", async () => {
    const view = render(
      <ControlledTriggerConfig
        initialConfig={{
          triggerType: "Webhook",
          webhookSchema: "",
          webhookEventPath: "",
          webhookCorrelationPath: "",
          webhookCreateEvents: "",
          webhookUpdateEvents: "",
          webhookDeleteEvents: "",
        }}
      />
    );

    await waitFor(() => {
      expect(view.getByText("Configuration Warnings")).toBeTruthy();
    });

    expect(view.getByText("Event type field path is empty.")).toBeTruthy();
  });

  it("auto-expands sample payload section when payload JSON is invalid", async () => {
    const view = render(
      <ControlledTriggerConfig
        initialConfig={{
          triggerType: "Webhook",
          webhookMockRequest: "{",
        }}
      />
    );

    await waitFor(() => {
      expect(view.getByText("Sample payload is not valid JSON.")).toBeTruthy();
    });
  });

  it("republishes the request schema as the trigger output contract", async () => {
    // Downstream autocomplete reads webhookOutputSchema, so anything that
    // rewrites the request schema has to move that key with it.
    let latestConfig: Record<string, unknown> = { triggerType: "Webhook" };

    const view = render(
      <ControlledTriggerConfig
        initialConfig={latestConfig}
        onConfigChange={(nextConfig) => {
          latestConfig = nextConfig;
        }}
      />
    );

    fireEvent.click(
      view.getByRole("button", { name: SAMPLE_PAYLOAD_BUTTON_REGEX })
    );
    fireEvent.click(view.getByRole("button", { name: "Appointment Canceled" }));

    await waitFor(() => {
      expect(typeof latestConfig.webhookSchema).toBe("string");
    });

    expect(JSON.parse(latestConfig.webhookSchema as string)).toEqual([
      { name: "type", type: "string" },
      { name: "timestamp", type: "timestamp" },
      {
        name: "data",
        type: "object",
        fields: [
          { name: "id", type: "string" },
          { name: "status", type: "string" },
        ],
      },
    ]);
    expect(latestConfig.webhookOutputSchema).toBe(latestConfig.webhookSchema);
  });

  it("loads sample payload templates with concrete default values", async () => {
    let latestConfig: Record<string, unknown> = {
      triggerType: "Webhook",
      webhookMockRequest: JSON.stringify({
        type: "old.type",
        timestamp: "2026-02-11T19:00:00Z",
        data: {
          id: "appt_123",
          startsAt: "2026-02-13T10:00:00-05:00",
          timezone: "America/New_York",
          status: "rescheduled",
        },
      }),
    };

    const view = render(
      <ControlledTriggerConfig
        initialConfig={latestConfig}
        onConfigChange={(nextConfig) => {
          latestConfig = nextConfig;
        }}
      />
    );

    fireEvent.click(
      view.getByRole("button", {
        name: SAMPLE_PAYLOAD_BUTTON_REGEX,
      })
    );
    fireEvent.click(
      view.getByRole("button", {
        name: "Appointment Rescheduled",
      })
    );

    await waitFor(() => {
      const rawPayload = latestConfig.webhookMockRequest;
      expect(typeof rawPayload).toBe("string");

      const parsedPayload = JSON.parse(rawPayload as string);
      expect(parsedPayload).toEqual({
        type: "appointment.rescheduled",
        timestamp: "2026-02-11T19:00:00Z",
        data: {
          id: "appt_123",
          startsAt: "2026-02-13T10:00:00-05:00",
          timezone: "America/New_York",
          status: "rescheduled",
        },
      });
    });
  });
});
