import { describe, expect, it } from "bun:test";
import { parseWebhookMockInput } from "./webhook-trigger";

/**
 * The mock request is JSON text the user typed into the trigger panel, and it
 * stands in for a real request body when a workflow is run by hand. A body is
 * always a JSON object, so this boundary parses the text and treats anything of
 * another shape as no mock at all.
 */
describe("parseWebhookMockInput", () => {
  it("reads a stored JSON object as the stand-in request body", () => {
    expect(
      parseWebhookMockInput({
        webhookMockRequest: '{"type":"appointment.create","data":{"id":"a_1"}}',
      })
    ).toEqual({ type: "appointment.create", data: { id: "a_1" } });
  });

  it("reads an empty object, which is a body with no fields", () => {
    expect(parseWebhookMockInput({ webhookMockRequest: "{}" })).toEqual({});
  });

  it("turns away JSON that is not an object, since a body cannot be one", () => {
    for (const raw of ["[1,2]", "[]", "null", '"appt_1"', "42", "true"]) {
      expect(
        parseWebhookMockInput({ webhookMockRequest: raw })
      ).toBeUndefined();
    }
  });

  it("turns away half-typed text without throwing out of the panel", () => {
    expect(
      parseWebhookMockInput({ webhookMockRequest: '{"type":' })
    ).toBeUndefined();
  });

  it("reports no mock when the config has none", () => {
    expect(parseWebhookMockInput(undefined)).toBeUndefined();
    expect(parseWebhookMockInput({})).toBeUndefined();
    expect(
      parseWebhookMockInput({ webhookMockRequest: "   " })
    ).toBeUndefined();
    expect(parseWebhookMockInput({ webhookMockRequest: 7 })).toBeUndefined();
  });
});
