import { evaluate as evaluateCel } from "@marcbachmann/cel-js";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "#src/types/json";
import {
  type EventSourceFilter,
  matchesSourceFilter,
} from "#src/lifecycle/event-source-filter";
import { compileEventDataEquals } from "#src/lifecycle/inngest-event-data";

/**
 * What Inngest decides for the compiled filter: the CEL expression evaluated
 * against the event, where an expression that errors, such as one reading a
 * missing field, does not trigger.
 */
function celDecides(when: EventSourceFilter, data: JsonObject): boolean {
  try {
    return (
      evaluateCel(compileEventDataEquals(when), { event: { data } }) === true
    );
  } catch {
    return false;
  }
}

/** The filters `compileEventDataEquals` is tested with, and payloads around each. */
const cases: { when: EventSourceFilter; data: JsonObject; matches: boolean }[] =
  [
    {
      when: { path: "event", equals: "appointment.canceled" },
      data: { event: "appointment.canceled" },
      matches: true,
    },
    {
      when: { path: "event", equals: "appointment.canceled" },
      data: { event: "appointment.created" },
      matches: false,
    },
    {
      when: { path: "meta.kind", equals: "created" },
      data: { meta: { kind: "created" } },
      matches: true,
    },
    {
      when: { path: "meta.kind", equals: "created" },
      data: { meta: { kind: "updated" } },
      matches: false,
    },
    {
      when: { path: "kind", equals: "it's on" },
      data: { kind: "it's on" },
      matches: true,
    },
    {
      when: { path: "kind", equals: 'say "hi"' },
      data: { kind: 'say "hi"' },
      matches: true,
    },
    {
      when: { path: "kind", equals: "a\\b" },
      data: { kind: "a\\b" },
      matches: true,
    },
    {
      when: { path: "kind", equals: "a\\b" },
      data: { kind: "ab" },
      matches: false,
    },
    {
      when: { path: "event-kind", equals: "created" },
      data: { "event-kind": "created" },
      matches: true,
    },
    {
      when: { path: " meta . kind ", equals: "created" },
      data: { meta: { kind: "created" } },
      matches: true,
    },
    // A missing key, a value of another type, and a path through a non-object
    // are errors to CEL, which Inngest reads as no match.
    {
      when: { path: "meta.kind", equals: "created" },
      data: {},
      matches: false,
    },
    {
      when: { path: "meta.kind", equals: "created" },
      data: { meta: "created" },
      matches: false,
    },
    {
      when: { path: "count", equals: "1" },
      data: { count: 1 },
      matches: false,
    },
    {
      when: { path: "flag", equals: "true" },
      data: { flag: true },
      matches: false,
    },
    {
      when: { path: "kind", equals: "created" },
      data: { kind: null },
      matches: false,
    },
  ];

describe("matchesSourceFilter", () => {
  it.each(cases)(
    "answers $matches for $when.path == $when.equals over $data, as the compiled CEL filter does",
    ({ when, data, matches }) => {
      expect(matchesSourceFilter(when, data)).toBe(matches);
      expect(celDecides(when, data)).toBe(matches);
    }
  );

  it("reads no inherited property of the payload", () => {
    expect(matchesSourceFilter({ path: "toString", equals: "x" }, {})).toBe(
      false
    );
  });

  it("refuses a path that names nothing", () => {
    expect(() =>
      matchesSourceFilter({ path: "  ", equals: "x" }, { x: "x" })
    ).toThrow("needs a payload path");
  });
});
