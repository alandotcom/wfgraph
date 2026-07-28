import type { Appointment } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "#src/acuity/credentials";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createAcuityClient, getAcuityErrorMessage } from "./client";
import { parseOptionalBoolean, parseRequiredInteger } from "./shared";

type GetAppointmentResult =
  | {
      success: true;
      data: {
        appointment: Appointment;
        id: number;
        datetime?: string;
      };
    }
  | { success: false; error: { message: string } };

export type GetAppointmentCoreInput = {
  appointmentId: string;
  pastFormAnswers?: string;
};

export type GetAppointmentInput = StepInput &
  GetAppointmentCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: GetAppointmentCoreInput,
  credentials: AcuityCredentials
): Promise<GetAppointmentResult> {
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

  const pastFormAnswers = parseOptionalBoolean(
    input.pastFormAnswers,
    "Include Past Form Answers"
  );
  if (!pastFormAnswers.ok) {
    return { success: false, error: { message: pastFormAnswers.error } };
  }

  try {
    const appointment = await clientResult.client.appointments.get(
      appointmentId.value,
      {
        pastFormAnswers: pastFormAnswers.value,
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
        message: getAcuityErrorMessage(error, "Failed to fetch appointment."),
      },
    };
  }
}

export async function getAppointmentStep(
  input: GetAppointmentInput
): Promise<GetAppointmentResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
