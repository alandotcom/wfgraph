/**
 * Server-side registrations for the built-in integrations.
 *
 * Everything registered here is loaded on demand, which is the point: a step
 * implementation and a connection test both pull vendor code, and neither
 * should enter the process until something calls it. Importing "@rova/plugins"
 * on its own gets the metadata the editor renders and nothing heavier, which is
 * what keeps the browser bundle free of server code.
 *
 * A host mounting Rova on a server imports this module once, beside
 * "@rova/plugins", and skips it if it wants only its own actions.
 *
 * `registerStep` takes a step written with `defineStep`; `registerStepFunction`
 * takes one that has not moved yet. Stage 6b of ADR-0002 is where the last of
 * the second kind becomes the first.
 */

import {
  registerIntegrationTest,
  registerStep,
  registerStepFunction,
} from "@rova/core/plugin";

registerStep(
  "twilio/send-sms",
  async () => (await import("#src/twilio/steps/send-sms")).sendSmsStep
);

registerStepFunction(
  "acuity/list-appointment-types",
  async () =>
    (await import("#src/acuity/steps/list-appointment-types"))
      .listAppointmentTypesStep
);

registerStepFunction(
  "acuity/list-appointments",
  async () =>
    (await import("#src/acuity/steps/list-appointments")).listAppointmentsStep
);

registerStepFunction(
  "acuity/get-appointment",
  async () =>
    (await import("#src/acuity/steps/get-appointment")).getAppointmentStep
);

registerStepFunction(
  "acuity/get-availability-dates",
  async () =>
    (await import("#src/acuity/steps/get-availability-dates"))
      .getAvailabilityDatesStep
);

registerStepFunction(
  "acuity/get-availability-times",
  async () =>
    (await import("#src/acuity/steps/get-availability-times"))
      .getAvailabilityTimesStep
);

registerStepFunction(
  "acuity/create-appointment",
  async () =>
    (await import("#src/acuity/steps/create-appointment")).createAppointmentStep
);

registerStepFunction(
  "acuity/reschedule-appointment",
  async () =>
    (await import("#src/acuity/steps/reschedule-appointment"))
      .rescheduleAppointmentStep
);

registerStepFunction(
  "acuity/cancel-appointment",
  async () =>
    (await import("#src/acuity/steps/cancel-appointment")).cancelAppointmentStep
);

registerStepFunction(
  "clerk/get-user",
  async () => (await import("#src/clerk/steps/get-user")).clerkGetUserStep
);

registerStepFunction(
  "clerk/create-user",
  async () => (await import("#src/clerk/steps/create-user")).clerkCreateUserStep
);

registerStepFunction(
  "clerk/update-user",
  async () => (await import("#src/clerk/steps/update-user")).clerkUpdateUserStep
);

registerStepFunction(
  "clerk/delete-user",
  async () => (await import("#src/clerk/steps/delete-user")).clerkDeleteUserStep
);

registerStepFunction(
  "linear/create-ticket",
  async () => (await import("#src/linear/steps/create-ticket")).createTicketStep
);

registerStepFunction(
  "linear/find-issues",
  async () => (await import("#src/linear/steps/find-issues")).findIssuesStep
);

registerStepFunction(
  "resend/send-email",
  async () => (await import("#src/resend/steps/send-email")).sendEmailStep
);

registerStepFunction(
  "slack/send-message",
  async () =>
    (await import("#src/slack/steps/send-slack-message")).sendSlackMessageStep
);

// Connection tests for the credentials UI. Each one reaches a vendor API, so it
// stays behind a dynamic import until someone presses "Test connection".
registerIntegrationTest(
  "acuity",
  async () => (await import("#src/acuity/test")).testAcuity
);
registerIntegrationTest(
  "clerk",
  async () => (await import("#src/clerk/test")).testClerk
);
registerIntegrationTest(
  "linear",
  async () => (await import("#src/linear/test")).testLinear
);
registerIntegrationTest(
  "resend",
  async () => (await import("#src/resend/test")).testResend
);
registerIntegrationTest(
  "slack",
  async () => (await import("#src/slack/test")).testSlack
);
registerIntegrationTest(
  "twilio",
  async () => (await import("#src/twilio/test")).testTwilio
);
