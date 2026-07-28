import { assert, describe, it } from "@effect/vitest";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import {
  Conflict,
  IntegrationValidationFailed,
  InternalFailure,
  InvalidInput,
  NotFound,
  type ServiceFailure,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import { toOrpcError } from "#src/backend/rpc/errors";

/**
 * The two edges every service failure leaves through.
 *
 * A failure class whose `kind` drifted would change the code an oRPC client
 * reads and the status a webhook sender reads, without changing anything either
 * adapter can see, so the mapping is pinned per class rather than per kind.
 */
const failures: Array<[ServiceFailure, string, number]> = [
  [new InvalidInput({ error: "Graph is malformed" }), "BAD_REQUEST", 400],
  [
    new IntegrationValidationFailed({
      error: "Invalid integration references in workflow",
      invalidIntegrationIds: ["int_1"],
    }),
    "BAD_REQUEST",
    400,
  ],
  [new Unauthorized({ error: "Invalid API key" }), "UNAUTHORIZED", 401],
  [new NotFound({ error: "Workflow not found" }), "NOT_FOUND", 404],
  [new Conflict({ error: "Name already taken" }), "CONFLICT", 409],
  [
    new InternalFailure({ error: "Failed to list API keys" }),
    "INTERNAL_SERVER_ERROR",
    500,
  ],
];

describe("toOrpcError", () => {
  it.each(failures)("gives %s the code its kind maps to", (failure, code) => {
    const error = toOrpcError(failure);

    assert.strictEqual(error.code, code);
    assert.deepStrictEqual(error.data, failure.payload);
  });

  // The editor reads these ids off the error's data to highlight the nodes it
  // has to send the user back to, so they travel as fields rather than prose.
  it("carries the refused integration ids through to the client", () => {
    const error = toOrpcError(
      new IntegrationValidationFailed({
        error: "Invalid integration references in workflow",
        invalidIntegrationIds: ["int_1", "int_2"],
      })
    );

    assert.deepStrictEqual(error.data, {
      error: "Invalid integration references in workflow",
      code: "integration_validation_failed",
      invalidIntegrationIds: ["int_1", "int_2"],
    });
  });
});

describe("responseFromServiceFailure", () => {
  it.each(failures)(
    "gives %s the status its kind maps to",
    async (failure, _code, status) => {
      const response = responseFromServiceFailure(failure);

      assert.strictEqual(response.status, status);
      assert.deepStrictEqual(await response.json(), failure.payload);
    }
  );

  it("keeps the headers the caller asked for", () => {
    const response = responseFromServiceFailure(
      new Unauthorized({ error: "Missing Authorization header" }),
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );

    assert.strictEqual(
      response.headers.get("Access-Control-Allow-Origin"),
      "*"
    );
    assert.strictEqual(response.status, 401);
  });
});
