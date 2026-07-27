import { registerIntegrationUi } from "@rova/shared/plugins/ui-registry";
import { UserCard } from "./components/user-card";
import { ClerkIcon } from "./icon";

// The editor-facing half of the Clerk plugin. Its counterpart, index.ts, holds
// plain metadata that the backend imports; the React components stay here, and
// only the browser bundle imports this module.
registerIntegrationUi("clerk", {
  icon: ClerkIcon,
  // The three actions that return a user render their output as a card. Keys
  // are action slugs, so "get-user" covers the "clerk/get-user" action.
  outputComponents: {
    "get-user": UserCard,
    "create-user": UserCard,
    "update-user": UserCard,
  },
});
