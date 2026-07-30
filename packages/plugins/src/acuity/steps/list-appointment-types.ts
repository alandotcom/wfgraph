import type { StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type {
  AcuityCredentials,
  listAppointmentTypesInput,
} from "#src/acuity/index";
import { callAcuity, createAcuityClient } from "./client";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies. The action takes no configuration, so the whole of it is the read.
 */
export const listAppointmentTypesHandler = Effect.fn(function* (
  _input: typeof listAppointmentTypesInput.Type,
  context: StepRunContext<AcuityCredentials>
) {
  const credentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  const appointmentTypes = yield* callAcuity(
    "Failed to list appointment types.",
    () => acuity.appointments.types()
  );

  return { appointmentTypes, count: appointmentTypes.length };
});
