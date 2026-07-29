import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  rescheduleAppointmentInput,
  rescheduleAppointmentOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import { optionalBoolean, optionalInteger, requiredInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const rescheduleAppointmentHandler = Effect.fn(function* (
  input: typeof rescheduleAppointmentInput.Type,
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

  if (!input.datetime.trim()) {
    return yield* Effect.fail(
      new StepFailure({
        message: "New Datetime is required (ISO 8601 format).",
      })
    );
  }

  const calendarID = yield* optionalInteger(input.calendarId, "Calendar ID");
  const admin = yield* optionalBoolean(input.admin, "Run as Admin");
  const noEmail = yield* optionalBoolean(
    input.noEmail,
    "Suppress Acuity Emails"
  );

  const appointment = yield* callAcuity(
    "Failed to reschedule appointment.",
    () =>
      acuity.appointments.reschedule(
        appointmentId,
        { datetime: input.datetime, calendarID },
        { admin, noEmail }
      )
  );

  // The id and the datetime sit beside the appointment as well as inside it,
  // because those two are what a downstream node reaches for most.
  return {
    appointment,
    id: appointment.id,
    datetime: appointment.datetime,
  };
});

export const rescheduleAppointmentStep = defineStep({
  id: "acuity/reschedule-appointment",
  input: rescheduleAppointmentInput,
  output: rescheduleAppointmentOutput,
  handler: rescheduleAppointmentHandler,
});
