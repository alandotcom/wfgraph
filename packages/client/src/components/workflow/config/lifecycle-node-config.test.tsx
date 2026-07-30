import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { LifecycleNodeConfig } from "#src/components/workflow/config/lifecycle-node-config";

const SAMPLE_PAYLOAD_BUTTON_REGEX = /^sample payload/i;

function ControlledConfig({
  initialConfig,
  onConfigChange,
}: {
  initialConfig: Record<string, unknown>;
  onConfigChange?: (config: Record<string, unknown>) => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);

  return (
    <LifecycleNodeConfig
      config={config}
      disabled={false}
      onUpdateConfig={(patch) =>
        setConfig((prev) => {
          const next = { ...prev, ...patch };
          onConfigChange?.(next);
          return next;
        })
      }
    />
  );
}

describe("LifecycleNodeConfig", () => {
  it("auto-expands sample payload section when payload JSON is invalid", async () => {
    const view = render(
      <ControlledConfig
        initialConfig={{
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
    let latestConfig: Record<string, unknown> = {};

    const view = render(
      <ControlledConfig
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
      <ControlledConfig
        initialConfig={latestConfig}
        onConfigChange={(nextConfig) => {
          latestConfig = nextConfig;
        }}
      />
    );

    // Nothing is wrong with the stored payload, so the section is closed and its
    // header is the way in.
    fireEvent.click(
      view.getByRole("button", { name: SAMPLE_PAYLOAD_BUTTON_REGEX })
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
