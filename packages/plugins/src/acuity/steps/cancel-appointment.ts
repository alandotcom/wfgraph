import { defineStep, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  cancelAppointmentInput,
  cancelAppointmentOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import { optionalBoolean, requiredInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const cancelAppointmentHandler = Effect.fn(function* (
  input: typeof cancelAppointmentInput.Type,
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
  const noShow = yield* optionalBoolean(input.noShow, "Mark as No-Show");
  const admin = yield* optionalBoolean(input.admin, "Run as Admin");
  const noEmail = yield* optionalBoolean(
    input.noEmail,
    "Suppress Acuity Emails"
  );

  const appointment = yield* callAcuity("Failed to cancel appointment.", () =>
    acuity.appointments.cancel(
      appointmentId,
      { cancelNote: input.cancelNote, noShow },
      { admin, noEmail }
    )
  );

  // The id and the flag sit beside the appointment as well as inside it,
  // because those two are what a downstream node reaches for most.
  return {
    appointment,
    id: appointment.id,
    canceled: appointment.canceled,
  };
});

export const cancelAppointmentStep = defineStep({
  id: "acuity/cancel-appointment",
  input: cancelAppointmentInput,
  output: cancelAppointmentOutput,
  handler: cancelAppointmentHandler,
});
