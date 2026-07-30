/**
 * The built-in integrations, as values.
 *
 * Nothing registers on import: this array is what a host hands to `createRovaApp`
 * under `extensions.integrations`, so the line that turns the built-ins on is a
 * line in the host's code and dropping it is what turns them off. Each entry is
 * server-only -- a vendor client, a connection test, a step handler -- and the
 * editor learns about all of it as JSON over `/api/extensions` instead.
 *
 * Each is also exported by name, for a host that lists some of the six rather than
 * all of them. That narrows what reaches `createRovaApp` and not what the process
 * loads: this module imports every integration as a value, so the vendor SDKs three
 * of them carry load with the package either way.
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
