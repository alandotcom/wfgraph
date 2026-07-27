import type { AppointmentType } from "@fountain-bio/acuity";
import type { AcuityCredentials } from "@/acuity/credentials";
import {
  fetchCredentials,
  type StepInput,
  withStepLogging,
} from "@rova/core/plugin";
import { createAcuityClient, getAcuityErrorMessage } from "./client";

type ListAppointmentTypesResult =
  | {
      success: true;
      data: {
        appointmentTypes: AppointmentType[];
        count: number;
      };
    }
  | { success: false; error: { message: string } };

export type ListAppointmentTypesInput = StepInput & {
  integrationId?: string;
};

async function stepHandler(
  credentials: AcuityCredentials
): Promise<ListAppointmentTypesResult> {
  const clientResult = createAcuityClient(credentials);
  if ("error" in clientResult) {
    return { success: false, error: { message: clientResult.error } };
  }

  try {
    const appointmentTypes = await clientResult.client.appointments.types();

    return {
      success: true,
      data: {
        appointmentTypes,
        count: appointmentTypes.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: getAcuityErrorMessage(
          error,
          "Failed to list appointment types."
        ),
      },
    };
  }
}

export async function listAppointmentTypesStep(
  input: ListAppointmentTypesInput
): Promise<ListAppointmentTypesResult> {
  const credentials = input.integrationId
    ? ((await fetchCredentials(input.integrationId)) as AcuityCredentials)
    : {};

  return withStepLogging(input, () => stepHandler(credentials));
}
