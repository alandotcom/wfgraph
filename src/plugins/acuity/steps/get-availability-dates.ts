
import type {
  AvailabilityDate,
  AvailabilityDatesParams,
} from "@fountain-bio/acuity";
import { fetchCredentials } from "@/backend/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/backend/lib/steps/step-handler";
import {
  createAcuityClient,
  getAcuityErrorMessage,
} from "./client";
import type { AcuityCredentials } from "../credentials";
import { parseOptionalInteger, parseRequiredInteger } from "./shared";

type GetAvailabilityDatesResult =
  | {
      success: true;
      data: {
        dates: AvailabilityDate[];
        count: number;
      };
    }
  | { success: false; error: { message: string } };

export type GetAvailabilityDatesCoreInput = {
  month: string;
  appointmentTypeId: string;
  calendarId?: string;
  timezone?: string;
};

export type GetAvailabilityDatesInput = StepInput &
  GetAvailabilityDatesCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAvailabilityDatesCoreInput,
  credentials: AcuityCredentials
): Promise<GetAvailabilityDatesResult> {
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

  if (!input.month?.trim()) {
    return {
      success: false,
      error: {
        message: "Month is required and must use YYYY-MM format.",
      },
    };
  }

  const params: AvailabilityDatesParams = {
    month: input.month,
    appointmentTypeID: appointmentTypeId.value,
    calendarID: calendarId.value,
    timezone: input.timezone,
  };

  try {
    const dates = await clientResult.client.availability.dates(params);

    return {
      success: true,
      data: {
        dates,
        count: dates.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(error, "Failed to fetch availability dates."),
      },
    };
  }
}

export async function getAvailabilityDatesStep(
  input: GetAvailabilityDatesInput
): Promise<GetAvailabilityDatesResult> {

  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
getAvailabilityDatesStep.maxRetries = 0;

export const _integrationType = "acuity";
