export type IntegrationType =
  | "acuity"
  | "clerk"
  | "database"
  | "linear"
  | "resend"
  | "slack"
  | "twilio";

const INTEGRATION_TYPE_MAP = {
  acuity: true,
  clerk: true,
  database: true,
  linear: true,
  resend: true,
  slack: true,
  twilio: true,
} as const satisfies Record<IntegrationType, true>;

export function isIntegrationType(value: unknown): value is IntegrationType {
  return (
    typeof value === "string" && Object.hasOwn(INTEGRATION_TYPE_MAP, value)
  );
}

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
