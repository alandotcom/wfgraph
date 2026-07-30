/**
 * The stored configuration of one connection.
 *
 * An integration's type is a plain string: the set of them is whatever a host
 * passed to `createRovaApp`, and the assembled catalog is where a reader asks
 * whether one exists. It used to be a closed union, which a global map keyed by
 * and a guard turned untrusted strings into; both went with the registry.
 *
 * The named keys are the ones this repo's own integrations write, spelled out so a
 * reader of a config can see what it may hold; the index signature is what makes
 * a host's own credential field a legal key.
 */
export type IntegrationConfig = {
  [key: string]: string | undefined;
  accountSid?: string;
  apiKey?: string;
  authToken?: string;
  clerkSecretKey?: string;
  fromEmail?: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  teamId?: string;
  url?: string;
  userId?: string;
};
