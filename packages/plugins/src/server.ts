/**
 * Server-side registrations for the built-in integrations.
 *
 * Everything registered here is loaded on demand, which is the point: a step
 * implementation and a connection test both pull vendor SDK code, and neither
 * should enter the process until something calls it. Importing "@rova/plugins"
 * on its own gets the metadata the editor renders and nothing heavier, which is
 * what keeps the browser bundle free of server code.
 *
 * A host mounting Rova on a server imports this module once, beside
 * "@rova/plugins", and skips it if it wants only its own actions.
 */

import { registerIntegrationTest } from "@/backend/services/integrations/integration-test-loaders";
import { registerStepImporter } from "@/backend/lib/step-registry";

registerStepImporter("acuity/list-appointment-types", {
  importer: () => import("@/acuity/steps/list-appointment-types"),
  stepFunction: "listAppointmentTypesStep",
  label: "List Appointment Types",
});

registerStepImporter("acuity/list-appointments", {
  importer: () => import("@/acuity/steps/list-appointments"),
  stepFunction: "listAppointmentsStep",
  label: "List Appointments",
});

registerStepImporter("acuity/get-appointment", {
  importer: () => import("@/acuity/steps/get-appointment"),
  stepFunction: "getAppointmentStep",
  label: "Get Appointment",
});

registerStepImporter("acuity/get-availability-dates", {
  importer: () => import("@/acuity/steps/get-availability-dates"),
  stepFunction: "getAvailabilityDatesStep",
  label: "Get Availability Dates",
});

registerStepImporter("acuity/get-availability-times", {
  importer: () => import("@/acuity/steps/get-availability-times"),
  stepFunction: "getAvailabilityTimesStep",
  label: "Get Availability Times",
});

registerStepImporter("acuity/create-appointment", {
  importer: () => import("@/acuity/steps/create-appointment"),
  stepFunction: "createAppointmentStep",
  label: "Create Appointment",
});

registerStepImporter("acuity/reschedule-appointment", {
  importer: () => import("@/acuity/steps/reschedule-appointment"),
  stepFunction: "rescheduleAppointmentStep",
  label: "Reschedule Appointment",
});

registerStepImporter("acuity/cancel-appointment", {
  importer: () => import("@/acuity/steps/cancel-appointment"),
  stepFunction: "cancelAppointmentStep",
  label: "Cancel Appointment",
});

registerStepImporter("clerk/get-user", {
  importer: () => import("@/clerk/steps/get-user"),
  stepFunction: "clerkGetUserStep",
  label: "Get User",
});

registerStepImporter("clerk/create-user", {
  importer: () => import("@/clerk/steps/create-user"),
  stepFunction: "clerkCreateUserStep",
  label: "Create User",
});

registerStepImporter("clerk/update-user", {
  importer: () => import("@/clerk/steps/update-user"),
  stepFunction: "clerkUpdateUserStep",
  label: "Update User",
});

registerStepImporter("clerk/delete-user", {
  importer: () => import("@/clerk/steps/delete-user"),
  stepFunction: "clerkDeleteUserStep",
  label: "Delete User",
});

registerStepImporter("linear/create-ticket", {
  importer: () => import("@/linear/steps/create-ticket"),
  stepFunction: "createTicketStep",
  label: "Create Ticket",
});

registerStepImporter("linear/find-issues", {
  importer: () => import("@/linear/steps/find-issues"),
  stepFunction: "findIssuesStep",
  label: "Find Issues",
});

registerStepImporter("resend/send-email", {
  importer: () => import("@/resend/steps/send-email"),
  stepFunction: "sendEmailStep",
  label: "Send Email",
});

registerStepImporter("slack/send-message", {
  importer: () => import("@/slack/steps/send-slack-message"),
  stepFunction: "sendSlackMessageStep",
  label: "Send Slack Message",
});

registerStepImporter("twilio/send-sms", {
  importer: () => import("@/twilio/steps/send-sms"),
  stepFunction: "sendSmsStep",
  label: "Send SMS",
});

// Connection tests for the credentials UI. Each one reaches a vendor API, so it
// stays behind a dynamic import until someone presses "Test connection".
registerIntegrationTest(
  "acuity",
  async () => (await import("@/acuity/test")).testAcuity
);
registerIntegrationTest(
  "clerk",
  async () => (await import("@/clerk/test")).testClerk
);
registerIntegrationTest(
  "linear",
  async () => (await import("@/linear/test")).testLinear
);
registerIntegrationTest(
  "resend",
  async () => (await import("@/resend/test")).testResend
);
registerIntegrationTest(
  "slack",
  async () => (await import("@/slack/test")).testSlack
);
registerIntegrationTest(
  "twilio",
  async () => (await import("@/twilio/test")).testTwilio
);
