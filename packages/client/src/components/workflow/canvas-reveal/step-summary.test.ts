import { describe, expect, it } from "vitest";
import type { ActionConfigField } from "@wfgraph/shared/plugins/action-fields";
import { summarizeActionFields, summarizeWait } from "./step-summary";

describe("summarizeActionFields", () => {
  const fields: ActionConfigField[] = [
    { key: "subject", label: "Subject", type: "template-input" },
    { key: "to", label: "To", type: "template-input", required: true },
    {
      key: "format",
      label: "Format",
      type: "select",
      options: [{ value: "html", label: "HTML" }],
    },
    {
      label: "Advanced",
      type: "group",
      fields: [
        { key: "headers", label: "Headers", type: "key-value" },
        {
          key: "replyTo",
          label: "Reply to",
          type: "text",
          showWhen: { field: "format", equals: "text" },
        },
      ],
    },
  ];

  it("lists required fields first, with labels and readable values", () => {
    expect(
      summarizeActionFields(fields, {
        subject: "Hello",
        format: "html",
        headers: '[{"key":"x","value":"y"}]',
      })
    ).toEqual([
      { key: "to", label: "To", value: null, required: true },
      { key: "subject", label: "Subject", value: "Hello", required: false },
      { key: "format", label: "Format", value: "HTML", required: false },
      { key: "headers", label: "Headers", value: "Set", required: false },
    ]);
  });

  it("treats a blank value as not set", () => {
    expect(summarizeActionFields(fields, { to: "   " })[0].value).toBeNull();
  });
});

describe("summarizeWait", () => {
  it("summarizes a delay Wait in the words of its form", () => {
    const rows = summarizeWait({
      waitMode: "delay",
      waitDuration: "24h",
      waitAllowedHoursMode: "daily_window",
      waitAllowedStartTime: "09:00",
      waitTimezone: "America/New_York",
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["How should this step wait?", "Wait for time"],
      ["Time source", "Duration"],
      ["Duration", "24h"],
      ["If the scheduled time has passed", "Continue immediately"],
      ["Allowed hours", "09:00 to Not set"],
      ["Timezone", "America/New_York"],
    ]);
  });

  it("summarizes a maximum-lateness gate", () => {
    const rows = summarizeWait({
      waitMode: "delay",
      waitDuration: "24h",
      waitGateMode: "max_lateness",
      waitMaxLateness: "6h",
    });

    expect(rows.map((row) => [row.label, row.value])).toContainEqual([
      "If the scheduled time has passed",
      "Continue within a limit",
    ]);
    expect(rows.map((row) => [row.label, row.value])).toContainEqual([
      "Continue if late by up to",
      "6h",
    ]);
  });

  it("summarizes an event Wait's timeout", () => {
    const rows = summarizeWait({ waitMode: "event", waitTimeout: "7d" });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["How should this step wait?", "Wait for an event"],
      ["Stop waiting after", "7d"],
      ["When time runs out", "Continue to the next step"],
    ]);
  });
});
