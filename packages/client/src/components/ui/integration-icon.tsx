import { Database, HelpCircle } from "lucide-react";
import { getIntegrationUi } from "@rova/shared/plugins/ui-registry";
import { cn } from "@rova/shared/utils";

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

  // Look up the icon the plugin registered from its ui.ts
  const ui = getIntegrationUi(integration);

  if (ui) {
    const PluginIcon = ui.icon;
    return <PluginIcon className={cn("text-foreground", className)} />;
  }

  // Fallback for unknown integrations
  return <HelpCircle className={cn("text-foreground", className)} />;
}
