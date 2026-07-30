/**
 * The built-in integrations, as values.
 *
 * Nothing registers on import: this array is what a host hands to `createRovaApp`
 * under `extensions.integrations`, so the line that turns the built-ins on is a
 * line in the host's code and dropping it is what turns them off. Each entry is
 * server-only -- a vendor client, a connection test, a step handler -- and the
 * editor learns about all of it as JSON over `/api/extensions` instead.
 *
 * Each is also exported by name, so a host that wants two of the six imports two
 * and has the rest tree-shaken out.
 */

export { acuity } from "#src/acuity/index";
export { clerk } from "#src/clerk/index";
export { linear } from "#src/linear/index";
export { resend } from "#src/resend/index";
export { slack } from "#src/slack/index";
export { twilio } from "#src/twilio/index";

import { acuity } from "#src/acuity/index";
import { clerk } from "#src/clerk/index";
import { linear } from "#src/linear/index";
import { resend } from "#src/resend/index";
import { slack } from "#src/slack/index";
import { twilio } from "#src/twilio/index";

export const builtInIntegrations = [
  acuity,
  clerk,
  linear,
  resend,
  slack,
  twilio,
];
