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
 * Every step is a `defineStep` under a checked id, so a registration naming an
 * action its step does not implement fails to compile.
 */

import { registerIntegrationTest, registerStep } from "@rova/core/plugin";

registerStep(
  "twilio/send-sms",
  async () => (await import("#src/twilio/steps/send-sms")).sendSmsStep
);

registerStep(
  "acuity/list-appointment-types",
  async () =>
    (await import("#src/acuity/steps/list-appointment-types"))
      .listAppointmentTypesStep
);

registerStep(
  "acuity/list-appointments",
  async () =>
    (await import("#src/acuity/steps/list-appointments")).listAppointmentsStep
);

registerStep(
  "acuity/get-appointment",
  async () =>
    (await import("#src/acuity/steps/get-appointment")).getAppointmentStep
);

registerStep(
  "acuity/get-availability-dates",
  async () =>
    (await import("#src/acuity/steps/get-availability-dates"))
      .getAvailabilityDatesStep
);

registerStep(
  "acuity/get-availability-times",
  async () =>
    (await import("#src/acuity/steps/get-availability-times"))
      .getAvailabilityTimesStep
);

registerStep(
  "acuity/create-appointment",
  async () =>
    (await import("#src/acuity/steps/create-appointment")).createAppointmentStep
);

registerStep(
  "acuity/reschedule-appointment",
  async () =>
    (await import("#src/acuity/steps/reschedule-appointment"))
      .rescheduleAppointmentStep
);

registerStep(
  "acuity/cancel-appointment",
  async () =>
    (await import("#src/acuity/steps/cancel-appointment")).cancelAppointmentStep
);

registerStep(
  "clerk/get-user",
  async () => (await import("#src/clerk/steps/get-user")).clerkGetUserStep
);

registerStep(
  "clerk/create-user",
  async () => (await import("#src/clerk/steps/create-user")).clerkCreateUserStep
);

registerStep(
  "clerk/update-user",
  async () => (await import("#src/clerk/steps/update-user")).clerkUpdateUserStep
);

registerStep(
  "clerk/delete-user",
  async () => (await import("#src/clerk/steps/delete-user")).clerkDeleteUserStep
);

registerStep(
  "linear/create-ticket",
  async () => (await import("#src/linear/steps/create-ticket")).createTicketStep
);

registerStep(
  "linear/find-issues",
  async () => (await import("#src/linear/steps/find-issues")).findIssuesStep
);

registerStep(
  "resend/send-email",
  async () => (await import("#src/resend/steps/send-email")).sendEmailStep
);

registerStep(
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
