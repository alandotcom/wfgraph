export type IntegrationType =
  | "acuity"
  | "clerk"
  | "database"
  | "linear"
  | "resend"
  | "slack"
  | "twilio";

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
