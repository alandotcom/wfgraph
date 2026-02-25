import type { IntegrationType } from "@/shared/types/integration";

export type IntegrationTestResult = {
  success: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type IntegrationTestFunction = (
  credentials: Record<string, string>
) => Promise<IntegrationTestResult>;

const integrationTestLoaders: Partial<
  Record<IntegrationType, () => Promise<IntegrationTestFunction>>
> = {
  acuity: async () => (await import("@/plugins/acuity/test")).testAcuity,
  clerk: async () => (await import("@/plugins/clerk/test")).testClerk,
  linear: async () => (await import("@/plugins/linear/test")).testLinear,
  resend: async () => (await import("@/plugins/resend/test")).testResend,
  slack: async () => (await import("@/plugins/slack/test")).testSlack,
  twilio: async () => (await import("@/plugins/twilio/test")).testTwilio,
};

export async function getIntegrationTestFunction(
  type: IntegrationType
): Promise<IntegrationTestFunction | null> {
  const loader = integrationTestLoaders[type];
  if (!loader) {
    return null;
  }

  return await loader();
}
