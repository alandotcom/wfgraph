import { defineStep, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  listAppointmentTypesInput,
  listAppointmentTypesOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies. The action takes no configuration, so the whole of it is the read.
 */
export const listAppointmentTypesHandler = Effect.fn(function* (
  _input: typeof listAppointmentTypesInput.Type,
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: AcuityCredentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  const appointmentTypes = yield* callAcuity(
    "Failed to list appointment types.",
    () => acuity.appointments.types()
  );

  return { appointmentTypes, count: appointmentTypes.length };
});

export const listAppointmentTypesStep = defineStep({
  id: "acuity/list-appointment-types",
  input: listAppointmentTypesInput,
  output: listAppointmentTypesOutput,
  handler: listAppointmentTypesHandler,
});
