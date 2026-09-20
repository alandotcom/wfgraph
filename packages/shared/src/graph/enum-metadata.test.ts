import { describe, expect, it } from "vitest";
import { enumLabelForValue, reconcileEnumMetadata } from "./enum-metadata";

describe("enumLabelForValue", () => {
  it("does not read labels inherited from the object prototype", () => {
    const labels = { active: "Active" };

    expect(enumLabelForValue(labels, "toString")).toBeUndefined();
    expect(enumLabelForValue(labels, "constructor")).toBeUndefined();
    expect(enumLabelForValue(labels, "__proto__")).toBeUndefined();
  });

  it("reads an own label for a reserved object key", () => {
    const labels = Object.fromEntries([["__proto__", "Prototype"]]);

    expect(enumLabelForValue(labels, "__proto__")).toBe("Prototype");
  });
});

describe("reconcileEnumMetadata", () => {
  it("keeps the first declaration's order when value sets and labels agree", () => {
    expect(
      reconcileEnumMetadata([
        {
          enumValues: ["InProgress", "NeedsReview"],
          enumLabels: {
            InProgress: "In progress",
            NeedsReview: "Needs review",
          },
        },
        {
          enumValues: ["NeedsReview", "InProgress"],
          enumLabels: {
            InProgress: "In progress",
            NeedsReview: "Needs review",
          },
        },
      ])
    ).toEqual({
      enumValues: ["InProgress", "NeedsReview"],
      enumLabels: {
        InProgress: "In progress",
        NeedsReview: "Needs review",
      },
    });
  });

  it("drops enum metadata when declarations offer different values", () => {
    expect(
      reconcileEnumMetadata([
        { enumValues: ["InProgress"] },
        { enumValues: ["NeedsReview"] },
      ])
    ).toEqual({});
  });

  it("keeps only labels every declaration gives the same raw value", () => {
    expect(
      reconcileEnumMetadata([
        {
          enumValues: ["InProgress", "NeedsReview", "constructor"],
          enumLabels: {
            InProgress: "In progress",
            NeedsReview: "Needs review",
          },
        },
        {
          enumValues: ["InProgress", "NeedsReview", "constructor"],
          enumLabels: {
            InProgress: "In progress",
            NeedsReview: "Review required",
          },
        },
      ])
    ).toEqual({
      enumValues: ["InProgress", "NeedsReview", "constructor"],
      enumLabels: { InProgress: "In progress" },
    });
  });
});
