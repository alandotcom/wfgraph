import { describe, expect, it } from "bun:test";
import { parseScheduleExpression } from "./schedule-expression";

describe("parseScheduleExpression", () => {
  it("parses daily natural language schedules", () => {
    const parsed = parseScheduleExpression("every day at 9am");

    expect(parsed).toEqual({
      cron: "0 9 * * *",
      source: "natural-language",
    });
  });

  it("parses weekday natural language schedules", () => {
    const parsed = parseScheduleExpression("every weekday at 6:30pm");

    expect(parsed).toEqual({
      cron: "30 18 * * 1-5",
      source: "natural-language",
    });
  });

  it("passes cron expressions through unchanged", () => {
    const parsed = parseScheduleExpression("0 9 * * *");

    expect(parsed).toEqual({
      cron: "0 9 * * *",
      source: "cron",
    });
  });
});
