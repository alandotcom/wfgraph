export type IntegrationType =
  | "acuity"
  | "clerk"
  | "database"
  | "linear"
  | "resend"
  | "slack"
  | "twilio";
export declare function isIntegrationType(
  value: unknown
): value is IntegrationType;
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
