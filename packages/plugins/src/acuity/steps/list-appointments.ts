import type { ListAppointmentsParams } from "@fountain-bio/acuity";
import { defineStep, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  listAppointmentsInput,
  listAppointmentsOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import { optionalBoolean, optionalInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies. What this step decides is which filters the config asked for, and
 * each field says for itself what is wrong with it.
 */
export const listAppointmentsHandler = Effect.fn(function* (
  input: typeof listAppointmentsInput.Type,
  context: StepRunContext
) {
  // The plugin's own credential vocabulary, so a key it never declares is a
  // compile error here rather than an undefined at run time.
  const credentials: AcuityCredentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  // Read in the order the form lists them, so a config with two bad fields
  // reports the one nearer the top of the panel.
  const appointmentTypeID = yield* optionalInteger(
    input.appointmentTypeId,
    "Appointment Type ID"
  );
  const calendarID = yield* optionalInteger(input.calendarId, "Calendar ID");
  const limit = yield* optionalInteger(input.limit, "Limit");
  const page = yield* optionalInteger(input.page, "Page");
  const canceled = yield* optionalBoolean(input.canceled, "Only Canceled");
  const showall = yield* optionalBoolean(input.showAll, "Include Inactive");

  // Acuity's own parameter names, so this reads like its documentation. The
  // SDK drops the ones left undefined.
  const params: ListAppointmentsParams = {
    appointmentTypeID,
    calendarID,
    minDate: input.minDate,
    maxDate: input.maxDate,
    timezone: input.timezone,
    email: input.email,
    phone: input.phone,
    canceled,
    showall,
    limit,
    page,
  };

  const appointments = yield* callAcuity("Failed to list appointments.", () =>
    acuity.appointments.list(params)
  );

  return { appointments, count: appointments.length };
});

export const listAppointmentsStep = defineStep({
  id: "acuity/list-appointments",
  input: listAppointmentsInput,
  output: listAppointmentsOutput,
  handler: listAppointmentsHandler,
});
