import type { AvailabilityDatesParams } from "@fountain-bio/acuity";
import {
  defineStep,
  StepFailure,
  type StepRunContext,
} from "@rova/core/plugin";
import { Effect } from "effect";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  getAvailabilityDatesInput,
  getAvailabilityDatesOutput,
} from "#src/acuity/schemas";
import { callAcuity, createAcuityClient } from "./client";
import { optionalInteger, requiredInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const getAvailabilityDatesHandler = Effect.fn(function* (
  input: typeof getAvailabilityDatesInput.Type,
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

  if (!input.month.trim()) {
    return yield* Effect.fail(
      new StepFailure({
        message: "Month is required and must use YYYY-MM format.",
      })
    );
  }

  // Acuity's own parameter names, so this reads like its documentation.
  const params: AvailabilityDatesParams = {
    month: input.month,
    appointmentTypeID,
    calendarID,
    timezone: input.timezone,
  };

  const dates = yield* callAcuity("Failed to fetch availability dates.", () =>
    acuity.availability.dates(params)
  );

  return { dates, count: dates.length };
});

export const getAvailabilityDatesStep = defineStep({
  id: "acuity/get-availability-dates",
  input: getAvailabilityDatesInput,
  output: getAvailabilityDatesOutput,
  handler: getAvailabilityDatesHandler,
});
