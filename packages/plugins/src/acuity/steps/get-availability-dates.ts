import type { AvailabilityDatesParams } from "@fountain-bio/acuity";
import { StepFailure, type StepRunContext } from "@rova/core/plugin";
import { Effect } from "effect";
import {
  getAvailabilityDatesInput,
  type AcuityCredentials,
} from "#src/acuity/index";
import { callAcuity, createAcuityClient } from "./client";
import { optionalInteger, requiredInteger } from "./shared";

/**
 * Named rather than written inline, so a test can run it with a context it
 * supplies.
 */
export const getAvailabilityDatesHandler = Effect.fn(function* (
  input: typeof getAvailabilityDatesInput.Type,
  context: StepRunContext<AcuityCredentials>
) {
  const credentials = yield* context.credentials;
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
