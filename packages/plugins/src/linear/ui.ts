import { registerIntegrationUi } from "@rova/shared/plugins/ui-registry";
import { LinearIcon } from "./icon";

// The editor-facing half of the Linear plugin. Its counterpart, index.ts, holds
// plain metadata that the backend imports; the React components stay here, and
// only the browser bundle imports this module.
registerIntegrationUi("linear", { icon: LinearIcon });
