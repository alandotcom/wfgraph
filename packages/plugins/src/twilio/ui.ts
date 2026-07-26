import { registerIntegrationUi } from "@/shared/plugins/ui-registry";
import { TwilioIcon } from "./icon";

// The editor-facing half of the Twilio plugin. Its counterpart, index.ts, holds
// plain metadata that the backend imports; the React components stay here, and
// only the browser bundle imports this module.
registerIntegrationUi("twilio", { icon: TwilioIcon });
