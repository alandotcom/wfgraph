import type { Appointment } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "@/acuity/credentials";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createAcuityClient, getAcuityErrorMessage } from "./client";
import { parseOptionalBoolean, parseRequiredInteger } from "./shared";

type CancelAppointmentResult =
  | {
      success: true;
      data: {
        appointment: Appointment;
        id: number;
        canceled?: boolean;
      };
    }
  | { success: false; error: { message: string } };

export type CancelAppointmentCoreInput = {
  appointmentId: string;
  cancelNote?: string;
  noShow?: string;
  admin?: string;
  noEmail?: string;
};

export type CancelAppointmentInput = StepInput &
  CancelAppointmentCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: CancelAppointmentCoreInput,
  credentials: AcuityCredentials
): Promise<CancelAppointmentResult> {
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

  const noShow = parseOptionalBoolean(input.noShow, "Mark as No-Show");
  if (!noShow.ok) {
    return { success: false, error: { message: noShow.error } };
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
    const appointment = await clientResult.client.appointments.cancel(
      appointmentId.value,
      {
        cancelNote: input.cancelNote,
        noShow: noShow.value,
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
        canceled: appointment.canceled,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(error, "Failed to cancel appointment."),
      },
    };
  }
}

export async function cancelAppointmentStep(
  input: CancelAppointmentInput
): Promise<CancelAppointmentResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
