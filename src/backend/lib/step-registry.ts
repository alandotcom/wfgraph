import {
  getRuntimeAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@/shared/workflow/action-registry";

type StepModule = Record<string, unknown>;

export type StepImporter = {
  importer: () => Promise<StepModule>;
  stepFunction: string;
  label?: string;
  execute?: (
    input: RuntimeActionExecuteInput
  ) => RuntimeActionResult | Promise<RuntimeActionResult>;
};

const STEP_IMPORTERS: Record<string, StepImporter> = {
  "acuity/list-appointment-types": {
    importer: () => import("@/plugins/acuity/steps/list-appointment-types"),
    stepFunction: "listAppointmentTypesStep",
    label: "List Appointment Types",
  },
  "acuity/list-appointments": {
    importer: () => import("@/plugins/acuity/steps/list-appointments"),
    stepFunction: "listAppointmentsStep",
    label: "List Appointments",
  },
  "acuity/get-appointment": {
    importer: () => import("@/plugins/acuity/steps/get-appointment"),
    stepFunction: "getAppointmentStep",
    label: "Get Appointment",
  },
  "acuity/get-availability-dates": {
    importer: () => import("@/plugins/acuity/steps/get-availability-dates"),
    stepFunction: "getAvailabilityDatesStep",
    label: "Get Availability Dates",
  },
  "acuity/get-availability-times": {
    importer: () => import("@/plugins/acuity/steps/get-availability-times"),
    stepFunction: "getAvailabilityTimesStep",
    label: "Get Availability Times",
  },
  "acuity/create-appointment": {
    importer: () => import("@/plugins/acuity/steps/create-appointment"),
    stepFunction: "createAppointmentStep",
    label: "Create Appointment",
  },
  "acuity/reschedule-appointment": {
    importer: () => import("@/plugins/acuity/steps/reschedule-appointment"),
    stepFunction: "rescheduleAppointmentStep",
    label: "Reschedule Appointment",
  },
  "acuity/cancel-appointment": {
    importer: () => import("@/plugins/acuity/steps/cancel-appointment"),
    stepFunction: "cancelAppointmentStep",
    label: "Cancel Appointment",
  },
  "clerk/get-user": {
    importer: () => import("@/plugins/clerk/steps/get-user"),
    stepFunction: "clerkGetUserStep",
    label: "Get User",
  },
  "clerk/create-user": {
    importer: () => import("@/plugins/clerk/steps/create-user"),
    stepFunction: "clerkCreateUserStep",
    label: "Create User",
  },
  "clerk/update-user": {
    importer: () => import("@/plugins/clerk/steps/update-user"),
    stepFunction: "clerkUpdateUserStep",
    label: "Update User",
  },
  "clerk/delete-user": {
    importer: () => import("@/plugins/clerk/steps/delete-user"),
    stepFunction: "clerkDeleteUserStep",
    label: "Delete User",
  },
  "linear/create-ticket": {
    importer: () => import("@/plugins/linear/steps/create-ticket"),
    stepFunction: "createTicketStep",
    label: "Create Ticket",
  },
  "linear/find-issues": {
    importer: () => import("@/plugins/linear/steps/find-issues"),
    stepFunction: "findIssuesStep",
    label: "Find Issues",
  },
  "resend/send-email": {
    importer: () => import("@/plugins/resend/steps/send-email"),
    stepFunction: "sendEmailStep",
    label: "Send Email",
  },
  "slack/send-message": {
    importer: () => import("@/plugins/slack/steps/send-slack-message"),
    stepFunction: "sendSlackMessageStep",
    label: "Send Slack Message",
  },
  "twilio/send-sms": {
    importer: () => import("@/plugins/twilio/steps/send-sms"),
    stepFunction: "sendSmsStep",
    label: "Send SMS",
  },
};

const SYSTEM_ACTION_LABELS: Record<string, string> = {
  Condition: "Condition",
  "Database Query": "Database Query",
  "HTTP Request": "HTTP Request",
  Wait: "Wait",
};

export function getStepImporter(actionType: string): StepImporter | undefined {
  const importer = STEP_IMPORTERS[actionType];
  if (importer) {
    return importer;
  }

  const runtimeAction = getRuntimeAction(actionType);
  if (!runtimeAction) {
    return;
  }

  return {
    importer: async () => ({}),
    stepFunction: "__runtime_execute__",
    label: runtimeAction.label,
    execute: runtimeAction.execute,
  };
}

export function getActionLabel(actionType: string): string | undefined {
  if (SYSTEM_ACTION_LABELS[actionType]) {
    return SYSTEM_ACTION_LABELS[actionType];
  }

  const runtimeAction = getRuntimeAction(actionType);
  if (runtimeAction) {
    return runtimeAction.label;
  }

  return STEP_IMPORTERS[actionType]?.label;
}

export function registerStepImporter(
  actionType: string,
  importer: StepImporter
): void {
  STEP_IMPORTERS[actionType] = importer;
}
