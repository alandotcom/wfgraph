import { registerIntegrationUi } from "@/shared/plugins/ui-registry";
import { SlackIcon } from "./icon";

// The editor-facing half of the Slack plugin. Its counterpart, index.ts, holds
// plain metadata that the backend imports; the React components stay here, and
// only the browser bundle imports this module.
registerIntegrationUi("slack", { icon: SlackIcon });
