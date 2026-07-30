/**
 * Every integration's React components: the icons and the custom output
 * renderers.
 *
 * Importing this module is what registers them, keyed by integration type. It is
 * the one surface where registration by import side effect survives, because a
 * component cannot be serialized and so cannot travel with the rest of the
 * catalog over `/api/extensions`. Only the browser imports it; a server bundle
 * takes `@rova/plugins` alone and carries no React.
 */

import "./acuity/ui";
import "./clerk/ui";
import "./linear/ui";
import "./resend/ui";
import "./slack/ui";
import "./twilio/ui";
