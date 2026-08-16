/**
 * Every integration's React components, keyed by integration type: the icons and
 * the custom output renderers.
 *
 * A component cannot be serialized, so this is the one half of an integration the
 * browser imports rather than reads off `/api/extensions`. Only the browser
 * imports it; a server bundle takes `@wfgraph/plugins` alone and carries no React.
 */

import type { ComponentType } from "react";
import { UserCard } from "#src/clerk/components/user-card";
import { ClerkIcon } from "#src/clerk/icon";
import { LinearIcon } from "#src/linear/icon";
import { ResendIcon } from "#src/resend/icon";
import { SlackIcon } from "#src/slack/icon";
import { TwilioIcon } from "#src/twilio/icon";

/** Props passed to a custom output renderer. */
export type ResultComponentProps = {
  output: unknown;
  input?: unknown;
};

export type IntegrationUi = {
  // Rendered wherever the integration is identified: node badges, selectors,
  // connection dialogs.
  icon: ComponentType<{ className?: string }>;

  // Custom renderers for step output in the workflow runs panel, keyed by the
  // action slug the plugin declares in its `actions` list (for example
  // "get-user", matching the "clerk/get-user" action ID).
  outputComponents?: Record<string, ComponentType<ResultComponentProps>>;
};

export const integrationUi = {
  clerk: {
    icon: ClerkIcon,
    outputComponents: {
      "get-user": UserCard,
      "create-user": UserCard,
      "update-user": UserCard,
    },
  },
  linear: { icon: LinearIcon },
  resend: { icon: ResendIcon },
  slack: { icon: SlackIcon },
  twilio: { icon: TwilioIcon },
} satisfies Record<string, IntegrationUi>;
