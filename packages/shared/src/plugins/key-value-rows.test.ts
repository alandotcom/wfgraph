import { describe, expect, it } from "vitest";
import { readKeyValueRows } from "./key-value-rows";

describe("readKeyValueRows", () => {
  it("reads the list the widget writes", () => {
    expect(
      readKeyValueRows(
        JSON.stringify([
          { name: "campaign", value: "spring" },
          { name: "order_id", value: "{{@n1:Order.id}}" },
        ])
      )
    ).toEqual([
      { name: "campaign", value: "spring" },
      { name: "order_id", value: "{{@n1:Order.id}}" },
    ]);
  });

  // A row is a row: neither of these is a mistake a reader should tidy away.
  it("keeps a blank name and a repeated one", () => {
    expect(
      readKeyValueRows(
        JSON.stringify([
          { name: "", value: "half typed" },
          { name: "batch", value: "a" },
          { name: "batch", value: "b" },
        ])
      )
    ).toEqual([
      { name: "", value: "half typed" },
      { name: "batch", value: "a" },
      { name: "batch", value: "b" },
    ]);
  });

  it("answers nothing for text it cannot read", () => {
    expect(readKeyValueRows("")).toBeNull();
    expect(readKeyValueRows("not json")).toBeNull();
    // The `provider-fields` shape, which has its own reader.
    expect(readKeyValueRows('{"NAME":"Ada"}')).toBeNull();
  });

  // One bad row loses the list rather than being dropped from it, because a
  // caller writing tags would otherwise send a set the builder never wrote.
  it("answers nothing when one row is not a row", () => {
    expect(
      readKeyValueRows(
        JSON.stringify([{ name: "ok", value: "yes" }, { name: "missing" }])
      )
    ).toBeNull();
    expect(
      readKeyValueRows(JSON.stringify([{ name: "n", value: 3 }]))
    ).toBeNull();
  });
});
