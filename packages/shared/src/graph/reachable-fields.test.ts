import { describe, expect, it } from "vitest";
import type { EventMetadata } from "#src/extensions/catalog";
import type { ReferenceField } from "#src/graph/node-references";
import { reachableEventFields } from "#src/graph/reachable-fields";

/** One Event, with its payload fields written out rather than derived. */
function anEvent(name: string, payloadFields: ReferenceField[]): EventMetadata {
  return { name, label: name, payloadFields };
}

const created = anEvent("app/appointment.created", [
  { path: "appointment.id", type: "string" },
  { path: "appointment.startsAt", type: "timestamp" },
]);

const rescheduled = anEvent("app/appointment.rescheduled", [
  { path: "appointment.id", type: "string" },
  { path: "appointment.startsAt", type: "timestamp" },
  { path: "appointment.previousStartsAt", type: "timestamp" },
]);

function fieldAt(fields: readonly { path: string }[], path: string) {
  const field = fields.find((candidate) => candidate.path === path);
  if (!field) {
    throw new Error(`No field at "${path}"`);
  }
  return field;
}

describe("reachableEventFields", () => {
  it("offers a path every Event declares as guaranteed", () => {
    const fields = reachableEventFields([created, rescheduled]);

    expect(fieldAt(fields, "appointment.id")).toEqual({
      path: "appointment.id",
      type: "string",
      declaredBy: ["app/appointment.created", "app/appointment.rescheduled"],
    });
  });

  it("marks a path only some Events declare as nullable", () => {
    // The superset case: `rescheduled` carries a field `created` does not, so a
    // run can arrive at the same node with the path absent.
    const fields = reachableEventFields([created, rescheduled]);

    expect(fieldAt(fields, "appointment.previousStartsAt")).toMatchObject({
      type: "timestamp",
      nullable: true,
      declaredBy: ["app/appointment.rescheduled"],
    });
  });

  it("keeps a declared nullable flag on a path every Event carries", () => {
    const fields = reachableEventFields([
      anEvent("a", [{ path: "note", type: "string", nullable: true }]),
      anEvent("b", [{ path: "note", type: "string" }]),
    ]);

    expect(fieldAt(fields, "note")).toMatchObject({ nullable: true });
  });

  it("reports a path the Events give different types as a clash", () => {
    const fields = reachableEventFields([
      anEvent("billing/payment.settled", [{ path: "amount", type: "number" }]),
      anEvent("billing/payment.failed", [{ path: "amount", type: "string" }]),
    ]);

    expect(fieldAt(fields, "amount")).toMatchObject({
      typeClash: {
        types: ["number", "string"],
        events: ["billing/payment.settled", "billing/payment.failed"],
      },
    });
  });

  it("leaves a clashing path without a type, so nothing reads one off it", () => {
    const fields = reachableEventFields([
      anEvent("a", [{ path: "amount", type: "number" }]),
      anEvent("b", [{ path: "amount", type: "string" }]),
    ]);

    expect(fieldAt(fields, "amount")).not.toHaveProperty("type");
  });

  it("agrees on a type one Event leaves undeclared", () => {
    // An undeclared type says nothing, so it cannot disagree with one that is
    // declared. The known type stands for the path.
    const fields = reachableEventFields([
      anEvent("a", [{ path: "amount", type: "number" }]),
      anEvent("b", [{ path: "amount" }]),
    ]);

    expect(fieldAt(fields, "amount")).toMatchObject({ type: "number" });
    expect(fieldAt(fields, "amount")).not.toHaveProperty("typeClash");
  });

  it("offers one Event's fields as declared", () => {
    const fields = reachableEventFields([created]);

    expect(fields.map((field) => field.path)).toEqual([
      "appointment.id",
      "appointment.startsAt",
    ]);
    expect(fieldAt(fields, "appointment.id")).toEqual({
      path: "appointment.id",
      type: "string",
      declaredBy: ["app/appointment.created"],
    });
  });

  it("answers nothing where no Event can reach the node", () => {
    expect(reachableEventFields([])).toEqual([]);
  });
});
