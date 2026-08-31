/**
 * What the template fields are filled with, and what they say when they cannot
 * be. The classification is the point: only `not_permitted` tells the builder
 * to reconnect, and only this file decides which refusal is which.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resendTemplateOptions,
  resendTemplateVariableFields,
} from "#src/resend/config-options";

const realFetch = globalThis.fetch;
let requests: Request[] = [];

function stubFetch(
  respond: (request: Request) => Response | Promise<Response>
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const credentials = { RESEND_API_KEY: "re_key" };

describe("the Resend template picker", () => {
  it("labels a draft so a missing template is never unexplained", async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { id: "tpl_1", name: "Welcome", status: "published" },
          { id: "tpl_2", name: "Half done", status: "draft" },
        ],
        has_more: false,
      })
    );

    await expect(resendTemplateOptions(credentials)).resolves.toEqual({
      status: "options",
      options: [
        { value: "tpl_1", label: "Welcome" },
        { value: "tpl_2", label: "Half done (draft)" },
      ],
    });
  });

  // Resend spells `restricted_api_key` twice: 401 for a send-only key, which
  // works and only wants a wider grant, and 403 for a key that is no longer
  // active, which reconnecting will not revive. Both are the operator's to act
  // on and neither is worth a retry, which is what `not_permitted` says.
  it.each([
    {
      name: "an OAuth grant too narrow to read",
      body: { name: "invalid_permission" },
      status: 403,
    },
    {
      name: "a send-only key",
      body: { name: "restricted_api_key" },
      status: 401,
    },
    {
      name: "a key Resend turned off",
      body: { name: "restricted_api_key" },
      status: 403,
    },
    {
      name: "a suspended key",
      body: { name: "suspended_api_key" },
      status: 403,
    },
  ])("asks the operator to act for $name", async ({ body, status }) => {
    stubFetch(() => Response.json(body, { status }));

    expect(await resendTemplateOptions(credentials)).toMatchObject({
      status: "unavailable",
      reason: "not_permitted",
    });
  });

  it("does not blame the grant for a 403 about something else", async () => {
    stubFetch(() =>
      Response.json(
        { name: "validation_error", message: "Something else entirely" },
        { status: 403 }
      )
    );

    // Sending someone to reconnect would send them where the fix is not, and
    // `not_permitted` is the one signal the panel offers an action on.
    expect(await resendTemplateOptions(credentials)).toMatchObject({
      status: "unavailable",
      reason: "refused",
      message: "Something else entirely",
    });
  });

  it("says the list is too long rather than showing part of it", async () => {
    let page = 0;
    stubFetch(() =>
      Response.json({
        data: [{ id: `tpl_${page++}`, name: "One", status: "published" }],
        has_more: true,
      })
    );

    expect(await resendTemplateOptions(credentials)).toMatchObject({
      status: "unavailable",
      reason: "refused",
    });
  });

  it("labels only what Resend calls a draft", async () => {
    stubFetch(() =>
      Response.json({
        data: [{ id: "tpl_1", name: "No status here" }],
        has_more: false,
      })
    );

    // A response omitting the status says nothing, rather than calling every
    // template unfinished.
    expect(await resendTemplateOptions(credentials)).toMatchObject({
      status: "options",
      options: [{ value: "tpl_1", label: "No status here" }],
    });
  });

  it("reports an unreachable provider as worth retrying", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("connect ECONNREFUSED"))) as typeof fetch;

    const answer = await resendTemplateOptions(credentials);

    expect(answer).toMatchObject({
      status: "unavailable",
      reason: "unreachable",
    });
  });

  it("reports any other refusal in Resend's own words", async () => {
    stubFetch(() =>
      Response.json({ message: "Something went wrong" }, { status: 500 })
    );

    expect(await resendTemplateOptions(credentials)).toMatchObject({
      status: "unavailable",
      reason: "refused",
      message: "Something went wrong",
    });
  });
});

describe("the Resend template variables", () => {
  it("draws one input per variable, with its fallback as the default", async () => {
    stubFetch(() =>
      Response.json({
        id: "tpl_1",
        name: "Welcome",
        status: "published",
        variables: [
          { key: "FIRST_NAME", type: "string" },
          { key: "CITY", type: "string", fallback_value: "Burbank" },
          { key: "RETRIES", type: "number", fallback_value: 3 },
          { key: "NULLED", type: "string", fallback_value: null },
          { key: "BLANK", type: "string", fallback_value: "" },
        ],
      })
    );

    const answer = await resendTemplateVariableFields(credentials, {
      parameters: { emailTemplateId: "tpl_1" },
    });

    expect(answer).toEqual({
      status: "fields",
      fields: [
        // No fallback means Resend refuses the send without a value, which is
        // the whole of what required means here.
        { key: "FIRST_NAME", label: "FIRST_NAME", required: true },
        { key: "CITY", label: "CITY", defaultValue: "Burbank" },
        {
          key: "RETRIES",
          label: "RETRIES",
          type: "number",
          defaultValue: "3",
        },
        { key: "NULLED", label: "NULLED", required: true },
        // An empty string is a fallback Resend applies, so it is not required.
        { key: "BLANK", label: "BLANK", defaultValue: "" },
      ],
    });
  });

  it("stops at Resend's own maximum", async () => {
    stubFetch(() =>
      Response.json({
        id: "tpl_1",
        name: "Welcome",
        variables: Array.from({ length: 60 }, (_unused, index) => ({
          key: `V${index}`,
          type: "string",
        })),
      })
    );

    const answer = await resendTemplateVariableFields(credentials, {
      parameters: { emailTemplateId: "tpl_1" },
    });

    expect(answer.status === "fields" && answer.fields).toHaveLength(50);
  });

  it("answers an empty set without spending a request", async () => {
    stubFetch(() => Response.json({}));

    const answer = await resendTemplateVariableFields(credentials, {
      parameters: {},
    });

    expect(answer).toEqual({ status: "fields", fields: [] });
    expect(requests).toHaveLength(0);
  });

  it("accepts an alias, which is what people actually type into Resend", async () => {
    stubFetch(() =>
      Response.json({ id: "tpl_1", name: "Welcome", variables: [] })
    );

    // Resend's retrieve endpoint takes an alias as readily as an id, and an
    // alias carrying a dot is ordinary. Refusing it on shape would fail a
    // template that sends perfectly well.
    await expect(
      resendTemplateVariableFields(credentials, {
        parameters: { emailTemplateId: "welcome.v2" },
      })
    ).resolves.toMatchObject({ status: "fields" });
    expect(requests[0]?.url).toBe(
      "https://api.resend.com/templates/welcome.v2"
    );
  });

  it("lets Resend answer for an id it does not hold", async () => {
    stubFetch(() =>
      Response.json(
        { name: "not_found", message: "Template not found" },
        { status: 404 }
      )
    );

    // `encodeURIComponent` is what makes the path safe, so a nonsense id spends
    // one request and comes back with Resend's own sentence.
    expect(
      await resendTemplateVariableFields(credentials, {
        parameters: { emailTemplateId: "../../admin" },
      })
    ).toMatchObject({
      status: "unavailable",
      reason: "refused",
      message: "Template not found",
    });
  });

  it("answers no variables for a template that declares none", async () => {
    stubFetch(() => Response.json({ id: "tpl_1", name: "Plain" }));

    await expect(
      resendTemplateVariableFields(credentials, {
        parameters: { emailTemplateId: "tpl_1" },
      })
    ).resolves.toEqual({ status: "fields", fields: [] });
  });
});
