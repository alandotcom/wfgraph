/** Production Linear SDK client construction from an API key. */

import { LinearClient } from "@linear/sdk";

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

export type CreateLinearClient = typeof createLinearClient;
