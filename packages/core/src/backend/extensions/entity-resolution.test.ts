import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineEntity } from "#src/backend/extensions/define-entity";
import {
  EntityResolutionTimedOut,
  resolveEntityState,
} from "#src/backend/extensions/entity-resolution";

const unresolvedEntity = defineEntity({
  type: "appointment",
  label: "Appointment",
  state: Schema.Struct({ status: Schema.String }),
  resolve: () => new Promise<never>(() => {}),
});

describe("resolveEntityState", () => {
  it("uses the app-owned timeout for a host resolver that does not settle", async () => {
    const failure = await Effect.runPromise(
      resolveEntityState({
        definition: unresolvedEntity,
        entityId: "appointment-1",
        timeoutMs: 5,
      }).pipe(Effect.flip)
    );

    expect(failure).toBeInstanceOf(EntityResolutionTimedOut);
  });
});
