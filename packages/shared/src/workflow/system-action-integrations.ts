import type { IntegrationType } from "#src/types/integration";

export const SYSTEM_ACTION_INTEGRATIONS: Readonly<
  Record<string, IntegrationType>
> = {
  "Database Query": "database",
};

export const SYSTEM_INTEGRATION_LABELS: Readonly<Record<string, string>> = {
  database: "Database",
};
