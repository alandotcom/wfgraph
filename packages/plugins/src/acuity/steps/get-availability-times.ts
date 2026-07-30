import type { AvailabilityTimesParams } from "@fountain-bio/acuity";
import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import {
  getAvailabilityTimesInput,
  type AcuityCredentials,
} from "#src/acuity/index";
import { callAcuity, createAcuityClient } from "./client";
import {
  optionalInteger,
  optionalIntegerList,
  requiredInteger,
} from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const getAvailabilityTimesHandler = Effect.fn(function* (
  input: typeof getAvailabilityTimesInput.Type,
  context: StepRunContext<AcuityCredentials>
) {
  const credentials = yield* context.credentials;
  const acuity = yield* createAcuityClient(credentials);

  const appointmentTypeID = yield* requiredInteger(
    input.appointmentTypeId,
    "Appointment Type ID"
  );
  const calendarID = yield* optionalInteger(input.calendarId, "Calendar ID");
  // Ignoring the appointment being moved is what lets its own slot show up
  // again, which is why rescheduling passes an id here.
  const ignoreAppointmentIDs = yield* optionalIntegerList(
    input.ignoreAppointmentIds,
    "Ignore Appointment IDs"
  );

  if (!input.date.trim()) {
    return yield* Effect.fail(
      new StepFailure({
        message: "Date is required and must use YYYY-MM-DD format.",
      })
    );
  }

  // Acuity's own parameter names, so this reads like its documentation.
  const params: AvailabilityTimesParams = {
    date: input.date,
    appointmentTypeID,
    calendarID,
    timezone: input.timezone,
    ignoreAppointmentIDs,
  };

  const slots = yield* callAcuity("Failed to fetch availability times.", () =>
    acuity.availability.times(params)
  );

  return { slots, count: slots.length };
});
