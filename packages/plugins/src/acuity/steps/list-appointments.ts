import type { Appointment, ListAppointmentsParams } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "@/acuity/credentials";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createAcuityClient, getAcuityErrorMessage } from "./client";
import { parseOptionalBoolean, parseOptionalInteger } from "./shared";

type ListAppointmentsResult =
  | {
      success: true;
      data: {
        appointments: Appointment[];
        count: number;
      };
    }
  | { success: false; error: { message: string } };

export type ListAppointmentsCoreInput = {
  appointmentTypeId?: string;
  calendarId?: string;
  minDate?: string;
  maxDate?: string;
  timezone?: string;
  email?: string;
  phone?: string;
  canceled?: string;
  showAll?: string;
  limit?: number;
  page?: number;
};

export type ListAppointmentsInput = StepInput &
  ListAppointmentsCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: ListAppointmentsCoreInput,
  credentials: AcuityCredentials
): Promise<ListAppointmentsResult> {
  const clientResult = createAcuityClient(credentials);
  if ("error" in clientResult) {
    return { success: false, error: { message: clientResult.error } };
  }

  const appointmentTypeId = parseOptionalInteger(
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

  const limit = parseOptionalInteger(input.limit, "Limit");
  if (!limit.ok) {
    return { success: false, error: { message: limit.error } };
  }

  const page = parseOptionalInteger(input.page, "Page");
  if (!page.ok) {
    return { success: false, error: { message: page.error } };
  }

  const canceled = parseOptionalBoolean(input.canceled, "Only Canceled");
  if (!canceled.ok) {
    return { success: false, error: { message: canceled.error } };
  }

  const showAll = parseOptionalBoolean(input.showAll, "Include Inactive");
  if (!showAll.ok) {
    return { success: false, error: { message: showAll.error } };
  }

  const params: ListAppointmentsParams = {
    appointmentTypeID: appointmentTypeId.value,
    calendarID: calendarId.value,
    minDate: input.minDate,
    maxDate: input.maxDate,
    timezone: input.timezone,
    email: input.email,
    phone: input.phone,
    canceled: canceled.value,
    showall: showAll.value,
    limit: limit.value,
    page: page.value,
  };

  try {
    const appointments = await clientResult.client.appointments.list(params);

    return {
      success: true,
      data: {
        appointments,
        count: appointments.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(error, "Failed to list appointments."),
      },
    };
  }
}

export async function listAppointmentsStep(
  input: ListAppointmentsInput
): Promise<ListAppointmentsResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
