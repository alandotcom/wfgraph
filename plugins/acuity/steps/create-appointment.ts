import "server-only";

import type { Appointment, CreateAppointmentPayload } from "@fountain-bio/acuity";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import {
  createAcuityClient,
  getAcuityErrorMessage,
} from "./client";
import type { AcuityCredentials } from "../credentials";
import {
  parseCustomFieldsJson,
  parseOptionalBoolean,
  parseOptionalInteger,
  parseRequiredInteger,
} from "./shared";

type CreateAppointmentResult =
  | {
      success: true;
      data: {
        appointment: Appointment;
        id: number;
        datetime?: string;
      };
    }
  | { success: false; error: { message: string } };

export type CreateAppointmentCoreInput = {
  datetime: string;
  appointmentTypeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  calendarId?: string;
  notes?: string;
  smsOptIn?: string;
  customFieldsJson?: string;
  admin?: string;
  noEmail?: string;
};

export type CreateAppointmentInput = StepInput &
  CreateAppointmentCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: CreateAppointmentCoreInput,
  credentials: AcuityCredentials
): Promise<CreateAppointmentResult> {
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

  const smsOptIn = parseOptionalBoolean(input.smsOptIn, "SMS Opt-In");
  if (!smsOptIn.ok) {
    return { success: false, error: { message: smsOptIn.error } };
  }

  const admin = parseOptionalBoolean(input.admin, "Run as Admin");
  if (!admin.ok) {
    return { success: false, error: { message: admin.error } };
  }

  const noEmail = parseOptionalBoolean(input.noEmail, "Suppress Acuity Emails");
  if (!noEmail.ok) {
    return { success: false, error: { message: noEmail.error } };
  }

  const customFields = parseCustomFieldsJson(input.customFieldsJson);
  if (!customFields.ok) {
    return { success: false, error: { message: customFields.error } };
  }

  if (!input.datetime?.trim()) {
    return {
      success: false,
      error: { message: "Datetime is required (ISO 8601 format)." },
    };
  }

  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    return {
      success: false,
      error: { message: "First Name and Last Name are required." },
    };
  }

  if (!input.email?.trim() || !input.phone?.trim()) {
    return {
      success: false,
      error: { message: "Email and Phone are required." },
    };
  }

  const payload: CreateAppointmentPayload = {
    datetime: input.datetime,
    appointmentTypeID: appointmentTypeId.value,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    calendarID: calendarId.value,
    notes: input.notes,
    smsOptIn: smsOptIn.value,
    fields: customFields.value,
  };

  try {
    const appointment = await clientResult.client.appointments.create(payload, {
      admin: admin.value,
      noEmail: noEmail.value,
    });

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
        message: getAcuityErrorMessage(error, "Failed to create appointment."),
      },
    };
  }
}

export async function createAppointmentStep(
  input: CreateAppointmentInput
): Promise<CreateAppointmentResult> {
  "use step";

  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
createAppointmentStep.maxRetries = 0;

export const _integrationType = "acuity";
