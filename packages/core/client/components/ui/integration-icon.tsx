import { Database, HelpCircle } from "lucide-react";
import { getIntegration } from "@/plugins/registry";
import { isIntegrationType } from "@/shared/types/integration";
import { cn } from "@/shared/utils";

interface IntegrationIconProps {
  integration: string;
  className?: string;
}

// Special icons for integrations without plugins
const SPECIAL_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  database: Database,
};

export function IntegrationIcon({
  integration,
  className = "h-3 w-3",
}: IntegrationIconProps) {
  // Check for special icons first (integrations without plugins)
  const SpecialIcon = SPECIAL_ICONS[integration];
  if (SpecialIcon) {
    return <SpecialIcon className={cn("text-foreground", className)} />;
  }

  // Look up plugin from registry
  const plugin = isIntegrationType(integration)
    ? getIntegration(integration)
    : undefined;

  if (plugin?.icon) {
    const PluginIcon = plugin.icon;
    return <PluginIcon className={cn("text-foreground", className)} />;
  }

  // Fallback for unknown integrations
  return <HelpCircle className={cn("text-foreground", className)} />;
}
