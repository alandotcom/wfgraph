import type {
  AvailabilityTimeSlot,
  AvailabilityTimesParams,
} from "@fountain-bio/acuity";
import type { AcuityCredentials } from "@/acuity/credentials";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import {
  type StepInput,
  withStepLogging,
} from "@/backend/lib/steps/step-handler";
import { createAcuityClient, getAcuityErrorMessage } from "./client";
import {
  parseCommaSeparatedIntegerList,
  parseOptionalInteger,
  parseRequiredInteger,
} from "./shared";

type GetAvailabilityTimesResult =
  | {
      success: true;
      data: {
        slots: AvailabilityTimeSlot[];
        count: number;
      };
    }
  | { success: false; error: { message: string } };

export type GetAvailabilityTimesCoreInput = {
  date: string;
  appointmentTypeId: string;
  calendarId?: string;
  timezone?: string;
  ignoreAppointmentIds?: string;
};

export type GetAvailabilityTimesInput = StepInput &
  GetAvailabilityTimesCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAvailabilityTimesCoreInput,
  credentials: AcuityCredentials
): Promise<GetAvailabilityTimesResult> {
  const clientResult = createAcuityClient(credentials);
  if ("error" in clientResult) {
    return { success: false, error: { message: clientResult.error } };
  }

  const appointmentTypeId = parseRequiredInteger(
    input.appointmentTypeId,
    "Appointment Type ID"
  );
  if (!appointmentTypeId.ok) {
    return { success: false, error: { message: appointmentTypeId.error } };
  }

  const calendarId = parseOptionalInteger(input.calendarId, "Calendar ID");
  if (!calendarId.ok) {
    return { success: false, error: { message: calendarId.error } };
  }

  const ignoreAppointmentIds = parseCommaSeparatedIntegerList(
    input.ignoreAppointmentIds,
    "Ignore Appointment IDs"
  );
  if (!ignoreAppointmentIds.ok) {
    return { success: false, error: { message: ignoreAppointmentIds.error } };
  }

  if (!input.date?.trim()) {
    return {
      success: false,
      error: {
        message: "Date is required and must use YYYY-MM-DD format.",
      },
    };
  }

  const params: AvailabilityTimesParams = {
    date: input.date,
    appointmentTypeID: appointmentTypeId.value,
    calendarID: calendarId.value,
    timezone: input.timezone,
    ignoreAppointmentIDs: ignoreAppointmentIds.value,
  };

  try {
    const slots = await clientResult.client.availability.times(params);

    return {
      success: true,
      data: {
        slots,
        count: slots.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(
          error,
          "Failed to fetch availability times."
        ),
      },
    };
  }
}

export async function getAvailabilityTimesStep(
  input: GetAvailabilityTimesInput
): Promise<GetAvailabilityTimesResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
getAvailabilityTimesStep.maxRetries = 0;

export const _integrationType = "acuity";
