import { assert, describe, it } from "@effect/vitest";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import {
  Conflict,
  IntegrationValidationFailed,
  InternalFailure,
  InvalidInput,
  NotFound,
  PublicationConflict,
  type ServiceFailure,
  Unauthorized,
} from "#src/backend/lib/effect/failures";
import { toOrpcError } from "#src/backend/rpc/errors";
import { PUBLICATION_CONFLICT_CODES } from "@wfgraph/shared/rpc/error-codes";

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
    new PublicationConflict({
      error: "This workflow was published elsewhere. Refresh and try again.",
      code: PUBLICATION_CONFLICT_CODES.stale,
    }),
    "CONFLICT",
    409,
  ],
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

  // The editor recovers from these two by their code: it ends the review the
  // publish was built on, or reports that there was nothing to publish. Reading
  // the sentence instead would break the moment the wording changed.
  it("carries the publication conflict code through to the client", () => {
    const error = toOrpcError(
      new PublicationConflict({
        error: "This workflow graph is already published.",
        code: PUBLICATION_CONFLICT_CODES.alreadyPublished,
      })
    );

    assert.deepStrictEqual(error.data, {
      error: "This workflow graph is already published.",
      code: "workflow_already_published",
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
});
