import { defineStep, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import { getAppointmentInput, getAppointmentOutput } from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import { optionalBoolean, requiredInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const getAppointmentHandler = Effect.fn(function* (
  input: typeof getAppointmentInput.Type,
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: AcuityCredentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  const appointmentId = yield* requiredInteger(
    input.appointmentId,
    "Appointment ID"
  );
  const pastFormAnswers = yield* optionalBoolean(
    input.pastFormAnswers,
    "Include Past Form Answers"
  );

  const appointment = yield* callAcuity("Failed to fetch appointment.", () =>
    acuity.appointments.get(appointmentId, { pastFormAnswers })
  );

  // The id and the datetime sit beside the appointment as well as inside it,
  // because those two are what a downstream node reaches for most.
  return {
    appointment,
    id: appointment.id,
    datetime: appointment.datetime,
  };
});

export const getAppointmentStep = defineStep({
  id: "acuity/get-appointment",
  input: getAppointmentInput,
  output: getAppointmentOutput,
  handler: getAppointmentHandler,
});
