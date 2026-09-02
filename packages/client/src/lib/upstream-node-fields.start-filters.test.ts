import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSharedEventConditionFields,
  seedConditionModelForField,
} from "#src/lib/upstream-node-fields";
import { EVENT_NAME_FIELD_PATH } from "@wfgraph/shared/conditions/conditions";
import {
  anAction,
  anEvent,
  createNode,
  createSurface,
  type MutableCatalog,
} from "#src/lib/upstream-node-fields-test-support";

/**
 * The vocabulary a collapsed Start Filter is written in.
 *
 * The rule under test is the intersection: a control standing for several Start
 * Events may only offer what those Events agree on, because a rule on a field one
 * of them lacks reads false on every arrival of that Event.
 */
describe("getSharedEventConditionFields", () => {
  let surface: MutableCatalog;
  beforeEach(() => {
    surface = createSurface();
  });

  const paths = (fields: { path: string }[]) => fields.map((f) => f.path);

  it("offers only the fields every named Event declares", () => {
    surface.events = [
      anEvent({
        name: "app/appointment.created",
        schema: Schema.Struct({
          id: Schema.String,
          channel: Schema.String,
          bookedBy: Schema.String,
        }),
      }),
      anEvent({
        name: "app/appointment.moved",
        schema: Schema.Struct({
          id: Schema.String,
          channel: Schema.String,
          movedBy: Schema.String,
        }),
      }),
    ];

    const fields = getSharedEventConditionFields(
      surface,
      ["app/appointment.created", "app/appointment.moved"],
      []
    );

    expect(paths(fields)).toEqual([EVENT_NAME_FIELD_PATH, "channel", "id"]);
  });

  it("drops a path the two Events declare at different types", () => {
    surface.events = [
      anEvent({
        name: "app/a",
        schema: Schema.Struct({ id: Schema.String, seats: Schema.Finite }),
      }),
      anEvent({
        name: "app/b",
        schema: Schema.Struct({ id: Schema.String, seats: Schema.String }),
      }),
    ];

    const fields = getSharedEventConditionFields(
      surface,
      ["app/a", "app/b"],
      []
    );

    expect(paths(fields)).toEqual([EVENT_NAME_FIELD_PATH, "id"]);
  });

  // One Event leaves nothing to select between, so the row that names the
  // arriving Event would offer a choice of one.
  it("omits the Event-name field for a single Start Event", () => {
    surface.events = [
      anEvent({ name: "app/a", schema: Schema.Struct({ id: Schema.String }) }),
    ];

    expect(
      paths(getSharedEventConditionFields(surface, ["app/a"], []))
    ).toEqual(["id"]);
  });

  it("answers with nothing when the Events share no field", () => {
    surface.events = [
      anEvent({ name: "app/a", schema: Schema.Struct({ a: Schema.String }) }),
      anEvent({ name: "app/b", schema: Schema.Struct({ b: Schema.String }) }),
    ];

    expect(
      paths(getSharedEventConditionFields(surface, ["app/a", "app/b"], []))
    ).toEqual([EVENT_NAME_FIELD_PATH]);
  });

  // Nullable widens rather than narrows: one Event able to send null is enough
  // for the filter to have to answer for it.
  it("keeps a field nullable when any Event calls it nullable", () => {
    surface.events = [
      anEvent({
        name: "app/a",
        schema: Schema.Struct({ note: Schema.NullOr(Schema.String) }),
      }),
      anEvent({
        name: "app/b",
        schema: Schema.Struct({ note: Schema.String }),
      }),
    ];

    const note = getSharedEventConditionFields(
      surface,
      ["app/a", "app/b"],
      []
    ).find((field) => field.path === "note");

    expect(note?.nullable).toBe(true);
  });

  it("keeps enum values only where the Events offer the same ones", () => {
    surface.events = [
      anEvent({
        name: "app/a",
        schema: Schema.Struct({
          channel: Schema.Literals(["video", "phone"]),
          status: Schema.Literals(["open", "closed"]),
        }),
      }),
      anEvent({
        name: "app/b",
        schema: Schema.Struct({
          channel: Schema.Literals(["video", "phone"]),
          status: Schema.Literals(["open", "closed", "archived"]),
        }),
      }),
    ];

    const fields = getSharedEventConditionFields(
      surface,
      ["app/a", "app/b"],
      []
    );

    expect(
      fields.find((field) => field.path === "channel")?.enumValues
    ).toEqual(["video", "phone"]);
    expect(
      fields.find((field) => field.path === "status")?.enumValues
    ).toBeUndefined();
  });

  it("answers with nothing when no Event is named", () => {
    expect(getSharedEventConditionFields(surface, [], [])).toEqual([]);
  });
});

/**
 * A key row under an open record is a shortcut for the record plus a key the
 * graph happens to name, and a rule stores those two apart. Seeding from the row
 * as it reads would write the joined path as the whole field, which is a path the
 * Event never declared: the picker would offer it, the save would take it, and
 * publish would refuse it naming a field the editor had just listed.
 */
describe("seedConditionModelForField over an open record", () => {
  let surface: MutableCatalog;
  beforeEach(() => {
    surface = createSurface();
    surface.events = [
      anEvent({
        name: "resend/email.delivered",
        integration: "resend",
        schema: Schema.Struct({ emailId: Schema.String }),
      }),
    ];
    // The catalog's own record field, which no schema can enumerate the keys of.
    surface.events = surface.events.map((event) => ({
      ...event,
      payloadFields: [
        ...event.payloadFields,
        { path: "tags", type: "object" as const, valueType: "string" as const },
      ],
    }));
    surface.actions = [
      anAction({
        id: "resend/send-email",
        integration: "resend",
        configFields: [
          {
            key: "emailTags",
            label: "Tags",
            type: "key-value",
            fillsRecords: ["tags"],
          },
        ],
        outputFields: [{ path: "id", type: "string" }],
      }),
    ];
  });

  /** A Send Email node naming one tag, which is what puts a key in the picker. */
  const sendNode = () =>
    createNode({
      id: "send-1",
      type: "action",
      label: "Send Email",
      config: {
        actionType: "resend/send-email",
        emailTags: JSON.stringify([{ name: "order", value: "o_1" }]),
      },
    });

  it("offers the key the graph names as a row of its own", () => {
    const fields = getSharedEventConditionFields(
      surface,
      ["resend/email.delivered"],
      [sendNode()]
    );

    const keyRow = fields.find((field) => field.path === "tags.order");
    expect(keyRow).toBeTruthy();
    expect(keyRow?.recordPath).toBe("tags");
    expect(keyRow?.recordKey).toBe("order");
  });

  it("seeds that row as the record plus its key, not as the joined path", () => {
    const fields = getSharedEventConditionFields(
      surface,
      ["resend/email.delivered"],
      [sendNode()]
    );
    const keyRow = fields.find((field) => field.path === "tags.order");
    if (!keyRow) {
      throw new Error("Expected the picker to offer the graph's tag key");
    }

    const [rule] =
      seedConditionModelForField(keyRow).groups[0]?.conditions ?? [];

    expect(rule?.field).toBe("tags");
    expect(rule?.recordKey).toBe("order");
  });

  it("seeds an ordinary field as itself", () => {
    const fields = getSharedEventConditionFields(
      surface,
      ["resend/email.delivered"],
      []
    );
    const plain = fields.find((field) => field.path === "emailId");
    if (!plain) {
      throw new Error("Expected the picker to offer the declared field");
    }

    const [rule] =
      seedConditionModelForField(plain).groups[0]?.conditions ?? [];

    expect(rule?.field).toBe("emailId");
    expect(rule?.recordKey).toBeUndefined();
  });
});

/**
 * One Event can carry a path as a key under an open record while another
 * declares the same path outright. The two read alike on the wire and store
 * differently, so a single control cannot stand for both: a rule built from the
 * key row names the record, which the Event declaring the joined form does not
 * have, and publish would refuse the filter the picker had just offered.
 */
describe("getSharedEventConditionFields over mixed record provenance", () => {
  let surface: MutableCatalog;
  beforeEach(() => {
    surface = createSurface();
    surface.events = [
      {
        ...anEvent({
          name: "app/tagged",
          integration: "resend",
          schema: Schema.Struct({ id: Schema.String }),
        }),
        payloadFields: [
          { path: "id", type: "string" },
          { path: "tags", type: "object", valueType: "string" },
        ],
      },
      {
        ...anEvent({
          name: "app/flat",
          schema: Schema.Struct({ id: Schema.String }),
        }),
        payloadFields: [
          { path: "id", type: "string" },
          { path: "tags.order", type: "string" },
        ],
      },
    ];
    surface.actions = [
      anAction({
        id: "resend/send-email",
        integration: "resend",
        configFields: [
          {
            key: "emailTags",
            label: "Tags",
            type: "key-value",
            fillsRecords: ["tags"],
          },
        ],
        outputFields: [{ path: "id", type: "string" }],
      }),
    ];
  });

  const sendNode = () =>
    createNode({
      id: "send-1",
      type: "action",
      label: "Send Email",
      config: {
        actionType: "resend/send-email",
        emailTags: JSON.stringify([{ name: "order", value: "o_1" }]),
      },
    });

  it("keeps a record key row out of what the two Events share", () => {
    const fields = getSharedEventConditionFields(
      surface,
      ["app/tagged", "app/flat"],
      [sendNode()]
    );

    expect(fields.map((field) => field.path)).toEqual([
      EVENT_NAME_FIELD_PATH,
      "id",
    ]);
  });

  it("still offers the key row when only the record-bearing Event is named", () => {
    const fields = getSharedEventConditionFields(
      surface,
      ["app/tagged"],
      [sendNode()]
    );

    expect(fields.some((field) => field.path === "tags.order")).toBe(true);
  });
});
