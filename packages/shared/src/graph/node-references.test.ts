import { describe, expect, it } from "vitest";
import {
  fieldsVisibleForConfig,
  findTemplateTokens,
  flattenSchemaToReferenceFields,
  formatTemplateToken,
  matchTemplateToken,
  parseTemplate,
  resolveOutputPath,
} from "./node-references";
import type { WorkflowSchemaField } from "./schema-codec";

describe("flattenSchemaToReferenceFields", () => {
  it("gives every primitive its own reference path", () => {
    const fields = flattenSchemaToReferenceFields([
      { name: "email", type: "string", description: "Contact email" },
      { name: "age", type: "number" },
    ]);

    expect(fields).toEqual([
      { path: "email", description: "Contact email", type: "string" },
      { path: "age", type: "number" },
    ]);
  });

  it("leaves an undescribed field carrying no description", () => {
    // A host writes their schema for validation, so most keys arrive without a
    // description. The picker shows the path and stays silent below it; a
    // surface needing a label derives one from the key.
    const fields = flattenSchemaToReferenceFields([
      {
        name: "appointment",
        type: "object",
        fields: [
          { name: "patientName", type: "string" },
          { name: "startsAt", type: "timestamp" },
          { name: "mediaUrls", type: "array", itemType: "string" },
        ],
      },
    ]);

    // toStrictEqual, because a key present and holding undefined is what this is
    // asserting against: the key has to be missing for a renderer to skip it.
    expect(fields).toStrictEqual([
      { path: "appointment", type: "object" },
      { path: "appointment.patientName", type: "string" },
      {
        path: "appointment.startsAt",
        type: "timestamp",
      },
      { path: "appointment.mediaUrls", type: "array" },
    ]);
  });

  it("emits the object itself and a dotted path per nested leaf", () => {
    const fields = flattenSchemaToReferenceFields([
      {
        name: "user",
        type: "object",
        fields: [
          { name: "name", type: "string" },
          {
            name: "address",
            type: "object",
            fields: [{ name: "city", type: "string" }],
          },
        ],
      },
    ]);

    expect(fields.map((field) => field.path)).toEqual([
      "user",
      "user.name",
      "user.address",
      "user.address.city",
    ]);
  });

  it("indexes into arrays of objects with a [0] segment", () => {
    const fields = flattenSchemaToReferenceFields([
      {
        name: "items",
        type: "array",
        itemType: "object",
        fields: [
          { name: "sku", type: "string" },
          { name: "shippedAt", type: "timestamp" },
        ],
      },
    ]);

    expect(fields).toEqual([
      { path: "items", type: "array" },
      { path: "items[0].sku", type: "string" },
      {
        path: "items[0].shippedAt",
        type: "timestamp",
      },
    ]);
  });

  it("stops at the array itself when the items are primitives", () => {
    const fields = flattenSchemaToReferenceFields([
      { name: "tags", type: "array", itemType: "string" },
    ]);

    expect(fields).toEqual([{ path: "tags", type: "array" }]);
  });

  it("carries nullable and enum values through to the flat field", () => {
    const fields = flattenSchemaToReferenceFields([
      {
        name: "status",
        type: "string",
        nullable: true,
        enumValues: ["open", "closed"],
      },
    ]);

    expect(fields).toEqual([
      {
        path: "status",
        type: "string",
        nullable: true,
        enumValues: ["open", "closed"],
      },
    ]);
  });

  it("skips fields with a blank name so they cannot produce a dangling path", () => {
    const fields = flattenSchemaToReferenceFields([
      { name: "   ", type: "string" },
      { name: "kept", type: "string" },
    ]);

    expect(fields.map((field) => field.path)).toEqual(["kept"]);
  });

  it("leaves an object with no named properties as a single entry", () => {
    // An open record, and also what a property the reader could not use leaves
    // behind. Either way there is no child to name.
    const fields = flattenSchemaToReferenceFields([
      { name: "metadata", type: "object", fields: [] },
    ]);

    expect(fields).toEqual([{ path: "metadata", type: "object" }]);
  });

  it("stops descending three segments down", () => {
    const fields = flattenSchemaToReferenceFields([
      {
        name: "a",
        type: "object",
        fields: [
          {
            name: "b",
            type: "object",
            fields: [
              {
                name: "c",
                type: "object",
                fields: [{ name: "d", type: "string" }],
              },
            ],
          },
        ],
      },
    ]);

    expect(fields.map((field) => field.path)).toEqual(["a", "a.b", "a.b.c"]);
  });

  it("terminates on a schema tree that points back at itself", () => {
    // Nothing this project parses builds one: a recursive schema describes
    // itself with a `$ref`, which the JSON Schema reader drops. A tree
    // assembled by hand can still loop, and the depth cap is what ends it.
    const node: WorkflowSchemaField = { name: "node", type: "object" };
    node.fields = [node];

    expect(flattenSchemaToReferenceFields([node]).map((f) => f.path)).toEqual([
      "node",
      "node.node",
      "node.node.node",
    ]);
  });
});

describe("matchTemplateToken", () => {
  it("splits a token into node id, label, and field path", () => {
    expect(matchTemplateToken("{{@node_1:Fetch User.profile.email}}")).toEqual({
      raw: "{{@node_1:Fetch User.profile.email}}",
      nodeId: "node_1",
      nodeLabel: "Fetch User",
      fieldPath: "profile.email",
      start: 0,
      end: 36,
    });
  });

  it("reads a whole-output token as an empty field path", () => {
    const token = matchTemplateToken("{{@node_1:Fetch User}}");

    expect(token?.nodeLabel).toBe("Fetch User");
    expect(token?.fieldPath).toBe("");
  });

  it("keeps bracket segments inside the field path", () => {
    expect(matchTemplateToken("{{@n1:Query.rows[0].id}}")?.fieldPath).toBe(
      "rows[0].id"
    );
  });

  it("finds the first token even when it is surrounded by other text", () => {
    const token = matchTemplateToken("Hi {{@n1:Greeter.name}}, welcome");

    expect(token?.nodeId).toBe("n1");
    expect(token?.start).toBe(3);
  });

  it("returns null for text that is not a node reference", () => {
    expect(matchTemplateToken("{{plainName.field}}")).toBeNull();
    expect(matchTemplateToken("no template here")).toBeNull();
    expect(matchTemplateToken("{{@n1 missing colon}}")).toBeNull();
  });

  it("refuses to span across a closing brace", () => {
    expect(matchTemplateToken("{{@a}} and {{b:c}}")).toBeNull();
  });
});

describe("findTemplateTokens", () => {
  it("returns every token in order with its position", () => {
    const tokens = findTemplateTokens("{{@a:First.x}} then {{@b:Second}} done");

    expect(tokens.map((token) => token.nodeId)).toEqual(["a", "b"]);
    expect(tokens.map((token) => token.start)).toEqual([0, 20]);
  });

  it("returns nothing for a string with no tokens", () => {
    expect(findTemplateTokens("just words")).toEqual([]);
  });
});

describe("parseTemplate", () => {
  it("interleaves literal text with tokens so callers can rebuild the string", () => {
    const segments = parseTemplate("Hi {{@n1:Greeter.name}}!");

    expect(segments).toEqual([
      { kind: "literal", text: "Hi " },
      {
        kind: "token",
        token: {
          raw: "{{@n1:Greeter.name}}",
          nodeId: "n1",
          nodeLabel: "Greeter",
          fieldPath: "name",
          start: 3,
          end: 23,
        },
      },
      { kind: "literal", text: "!" },
    ]);
  });

  it("omits empty literals between adjacent tokens", () => {
    const segments = parseTemplate("{{@a:A.x}}{{@b:B.y}}");

    expect(segments.map((segment) => segment.kind)).toEqual(["token", "token"]);
  });

  it("treats a string with no tokens as one literal", () => {
    expect(parseTemplate("plain")).toEqual([
      { kind: "literal", text: "plain" },
    ]);
  });

  it("produces nothing for an empty string", () => {
    expect(parseTemplate("")).toEqual([]);
  });
});

describe("formatTemplateToken", () => {
  it("writes a field reference in the canonical form the parser reads back", () => {
    const raw = formatTemplateToken({
      nodeId: "n1",
      nodeLabel: "Fetch User",
      fieldPath: "profile.email",
    });

    expect(raw).toBe("{{@n1:Fetch User.profile.email}}");
    expect(matchTemplateToken(raw)?.fieldPath).toBe("profile.email");
  });

  it("omits the trailing dot when no field path is given", () => {
    expect(formatTemplateToken({ nodeId: "n1", nodeLabel: "Fetch User" })).toBe(
      "{{@n1:Fetch User}}"
    );
  });
});

describe("resolveOutputPath", () => {
  it("walks a dotted path through nested objects", () => {
    const value = resolveOutputPath(
      { user: { profile: { email: "a@b.co" } } },
      "user.profile.email"
    );

    expect(value).toBe("a@b.co");
  });

  it("returns the whole output when the path is empty", () => {
    const output = { id: 1 };

    expect(resolveOutputPath(output, "")).toBe(output);
  });

  it("looks inside a step wrapper without being told to", () => {
    const output = { success: true, data: { id: "cus_1" } };

    expect(resolveOutputPath(output, "id")).toBe("cus_1");
  });

  it("walks a nested path through a step wrapper", () => {
    // The path the picker offers for a nested payload, against the shape a step
    // actually files: the wrapper is stepped over and the rest is walked.
    const output = {
      success: true,
      data: { appointment: { id: "appt_1" } },
    };

    expect(resolveOutputPath(output, "appointment.id")).toBe("appt_1");
  });

  // A step's data can carry several sibling fields beside the main payload --
  // a status code beside a response body, a count beside a list -- and each is
  // reached the same way a lone field is: through the unwrap, not around it.
  it("reaches a field a step filed beside another one", () => {
    const output = {
      success: true,
      data: { body: { id: "evt_1" }, status: 201 },
    };

    expect(resolveOutputPath(output, "status")).toBe(201);
    expect(resolveOutputPath(output, "body.id")).toBe("evt_1");
  });

  it("reads the wrapper itself when the path names one of its own keys", () => {
    const output = { success: true, data: { id: "cus_1" } };

    expect(resolveOutputPath(output, "success")).toBe(true);
    expect(resolveOutputPath(output, "data.id")).toBe("cus_1");
    expect(
      resolveOutputPath(
        { success: false, error: { message: "no" }, data: null },
        "error.message"
      )
    ).toBe("no");
  });

  it("leaves an object that merely has a data key alone", () => {
    const output = { data: { id: "raw" } };

    expect(resolveOutputPath(output, "id")).toBeUndefined();
    expect(resolveOutputPath(output, "data.id")).toBe("raw");
  });

  it("indexes into an array with a bracket segment", () => {
    const output = { rows: [{ id: "first" }, { id: "second" }] };

    expect(resolveOutputPath(output, "rows[1].id")).toBe("second");
  });

  it("follows chained bracket segments into nested arrays", () => {
    const output = { grid: [[10, 20], [30]] };

    expect(resolveOutputPath(output, "grid[0][1]")).toBe(20);
  });

  it("indexes a top-level array output", () => {
    expect(resolveOutputPath([{ id: "a" }, { id: "b" }], "[1].id")).toBe("b");
  });

  it("returns undefined when a bracket index is out of range", () => {
    expect(resolveOutputPath({ rows: [] }, "rows[0].id")).toBeUndefined();
  });

  it("returns undefined when a bracket segment is applied to a non-array", () => {
    expect(resolveOutputPath({ rows: { id: "a" } }, "rows[0]")).toBeUndefined();
  });

  it("returns undefined for a missing key rather than throwing", () => {
    expect(resolveOutputPath({ a: 1 }, "b.c.d")).toBeUndefined();
    expect(resolveOutputPath(null, "a")).toBeUndefined();
    expect(resolveOutputPath("a string", "length")).toBeUndefined();
  });

  it("preserves a null leaf so callers can tell it apart from a missing key", () => {
    expect(resolveOutputPath({ a: null }, "a")).toBeNull();
  });

  it("resolves a path the flattener produced for an array of objects", () => {
    const [, itemPath] = flattenSchemaToReferenceFields([
      {
        name: "items",
        type: "array",
        itemType: "object",
        fields: [{ name: "sku", type: "string" }],
      },
    ]);

    expect(
      resolveOutputPath({ items: [{ sku: "SKU-1" }] }, itemPath.path)
    ).toBe("SKU-1");
  });
});

describe("fieldsVisibleForConfig", () => {
  it("keeps fields whose showWhen matches the config", () => {
    const fields = [
      { path: "always", type: "string" as const },
      {
        path: "onEvent",
        type: "string" as const,
        showWhen: { field: "waitMode", equals: "event" },
      },
    ];

    expect(
      fieldsVisibleForConfig({ waitMode: "delay" }, fields).map((f) => f.path)
    ).toEqual(["always"]);
    expect(
      fieldsVisibleForConfig({ waitMode: "event" }, fields).map((f) => f.path)
    ).toEqual(["always", "onEvent"]);
  });
});
