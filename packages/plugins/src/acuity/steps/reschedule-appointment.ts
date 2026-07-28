import type { Appointment } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createAcuityClient, getAcuityErrorMessage } from "./client";
import {
  parseOptionalBoolean,
  parseOptionalInteger,
  parseRequiredInteger,
} from "./shared";

type RescheduleAppointmentResult =
  | {
      success: true;
      data: {
        appointment: Appointment;
        id: number;
        datetime?: string;
      };
    }
  | { success: false; error: { message: string } };

export type RescheduleAppointmentCoreInput = {
  appointmentId: string;
  datetime: string;
  calendarId?: string;
  admin?: string;
  noEmail?: string;
};

export type RescheduleAppointmentInput = StepInput &
  RescheduleAppointmentCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: RescheduleAppointmentCoreInput,
  credentials: AcuityCredentials
): Promise<RescheduleAppointmentResult> {
  const clientResult = createAcuityClient(credentials);
  if ("error" in clientResult) {
    return { success: false, error: { message: clientResult.error } };
  }

  const appointmentId = parseRequiredInteger(
    input.appointmentId,
    "Appointment ID"
  );
  if (!appointmentId.ok) {
    return { success: false, error: { message: appointmentId.error } };
  }

  if (!input.datetime?.trim()) {
    return {
      success: false,
      error: { message: "New Datetime is required (ISO 8601 format)." },
    };
  }

  const calendarId = parseOptionalInteger(input.calendarId, "Calendar ID");
  if (!calendarId.ok) {
    return { success: false, error: { message: calendarId.error } };
  }

  const admin = parseOptionalBoolean(input.admin, "Run as Admin");
  if (!admin.ok) {
    return { success: false, error: { message: admin.error } };
  }

  const noEmail = parseOptionalBoolean(input.noEmail, "Suppress Acuity Emails");
  if (!noEmail.ok) {
    return { success: false, error: { message: noEmail.error } };
  }

  try {
    const appointment = await clientResult.client.appointments.reschedule(
      appointmentId.value,
      {
        datetime: input.datetime,
        calendarID: calendarId.value,
      },
      {
        admin: admin.value,
        noEmail: noEmail.value,
      }
    );

    return {
      success: true,
      data: {
        appointment,
        id: appointment.id,
        datetime: appointment.datetime,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(
          error,
          "Failed to reschedule appointment."
        ),
      },
    };
  }
}

export async function rescheduleAppointmentStep(
  input: RescheduleAppointmentInput
): Promise<RescheduleAppointmentResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
