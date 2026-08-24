/**
 * The built-in integrations, as factories.
 *
 * Nothing registers on import: a host calls `builtInIntegrations()` and hands the
 * returned values to `createWfGraphApp` under `extensions.integrations`. Each entry
 * is server-only -- a client, a connection test, a step handler -- and the editor
 * learns about all of it as JSON over `/api/extensions` instead.
 *
 * Each factory is also exported by name, for a host that lists some of the five
 * rather than all of them. Calling a factory creates a fresh integration value.
 */

export { clerk } from "#src/clerk/index";
export { linear } from "#src/linear/index";
export { resend } from "#src/resend/index";
export { slack, type SlackOptions } from "#src/slack/index";
export { twilio } from "#src/twilio/index";

import { clerk } from "#src/clerk/index";
import { linear } from "#src/linear/index";
import { resend } from "#src/resend/index";
import { slack, type SlackOptions } from "#src/slack/index";
import { twilio } from "#src/twilio/index";

export type BuiltInIntegrationsOptions = {
  slack?: SlackOptions;
};

export const builtInIntegrations = (options?: BuiltInIntegrationsOptions) => [
  clerk(),
  linear(),
  resend(),
  slack(options?.slack),
  twilio(),
];
