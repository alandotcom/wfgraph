/**
 * Plugin UI Index
 *
 * Importing this module registers every plugin's React components: the
 * integration icons and the custom output renderers. The browser bundle imports
 * it alongside "@rova/plugins", which registers the plugin metadata. Server code
 * imports "@rova/plugins" by itself, so its bundle carries server code only.
 */

import "./acuity/ui";
import "./clerk/ui";
import "./linear/ui";
import "./resend/ui";
import "./slack/ui";
import "./twilio/ui";
