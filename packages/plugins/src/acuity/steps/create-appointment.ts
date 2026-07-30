import type { CreateAppointmentPayload } from "@fountain-bio/acuity";
import {
  defineLegacyStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  createAppointmentInput,
  createAppointmentOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import {
  optionalBoolean,
  optionalCustomFields,
  optionalInteger,
  requiredInteger,
} from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies. What this step decides is what a booking looks like, and each
 * field says for itself what is wrong with it.
 */
export const createAppointmentHandler = Effect.fn(function* (
  input: typeof createAppointmentInput.Type,
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: AcuityCredentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  const appointmentTypeID = yield* requiredInteger(
    input.appointmentTypeId,
    "Appointment Type ID"
  );
  const calendarID = yield* optionalInteger(input.calendarId, "Calendar ID");
  const smsOptIn = yield* optionalBoolean(input.smsOptIn, "SMS Opt-In");
  const admin = yield* optionalBoolean(input.admin, "Run as Admin");
  const noEmail = yield* optionalBoolean(
    input.noEmail,
    "Suppress Acuity Emails"
  );
  const fields = yield* optionalCustomFields(input.customFieldsJson);

  if (!input.datetime.trim()) {
    return yield* Effect.fail(
      new StepFailure({
        message: "Datetime is required (ISO 8601 format).",
      })
    );
  }

  if (!(input.firstName.trim() && input.lastName.trim())) {
    return yield* Effect.fail(
      new StepFailure({ message: "First Name and Last Name are required." })
    );
  }

  if (!(input.email.trim() && input.phone.trim())) {
    return yield* Effect.fail(
      new StepFailure({ message: "Email and Phone are required." })
    );
  }

  // Acuity's own parameter names, so this reads like its documentation.
  const payload: CreateAppointmentPayload = {
    datetime: input.datetime,
    appointmentTypeID,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    calendarID,
    notes: input.notes,
    smsOptIn,
    fields,
  };

  const appointment = yield* callAcuity("Failed to create appointment.", () =>
    acuity.appointments.create(payload, { admin, noEmail })
  );

  // The id and the datetime sit beside the appointment as well as inside it,
  // because those two are what a downstream node reaches for most.
  return {
    appointment,
    id: appointment.id,
    datetime: appointment.datetime,
  };
});

export const createAppointmentStep = defineLegacyStep({
  id: "acuity/create-appointment",
  input: createAppointmentInput,
  output: createAppointmentOutput,
  handler: createAppointmentHandler,
});
