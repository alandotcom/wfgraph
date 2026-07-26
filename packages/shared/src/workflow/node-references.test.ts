import { describe, expect, it } from "bun:test";
import {
  findTemplateTokens,
  flattenSchemaToReferenceFields,
  formatTemplateToken,
  matchTemplateToken,
  parseTemplate,
  resolveOutputPath,
} from "./node-references";

describe("flattenSchemaToReferenceFields", () => {
  it("gives every primitive its own reference path", () => {
    const fields = flattenSchemaToReferenceFields([
      { name: "email", type: "string", description: "Contact email" },
      { name: "age", type: "number" },
    ]);

    expect(fields).toEqual([
      { path: "email", description: "Contact email", type: "string" },
      { path: "age", description: "number", type: "number" },
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
      { path: "items", description: "object[]", type: "array" },
      { path: "items[0].sku", description: "string", type: "string" },
      {
        path: "items[0].shippedAt",
        description: "timestamp",
        type: "timestamp",
        format: "timestamp",
      },
    ]);
  });

  it("stops at the array itself when the items are primitives", () => {
    const fields = flattenSchemaToReferenceFields([
      { name: "tags", type: "array", itemType: "string" },
    ]);

    expect(fields).toEqual([
      { path: "tags", description: "string[]", type: "array" },
    ]);
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
        description: "string",
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
    const tokens = findTemplateTokens(
      "{{@a:First.x}} then {{@b:Second}} done"
    );

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
    expect(parseTemplate("plain")).toEqual([{ kind: "literal", text: "plain" }]);
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

  it("reads the wrapper itself when the path names one of its own keys", () => {
    const output = { success: true, data: { id: "cus_1" } };

    expect(resolveOutputPath(output, "success")).toBe(true);
    expect(resolveOutputPath(output, "data.id")).toBe("cus_1");
    expect(resolveOutputPath({ success: false, error: { message: "no" }, data: null }, "error.message")).toBe("no");
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

    expect(resolveOutputPath({ items: [{ sku: "SKU-1" }] }, itemPath.path)).toBe(
      "SKU-1"
    );
  });
});
