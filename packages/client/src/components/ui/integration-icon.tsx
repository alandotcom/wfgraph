import { Database, HelpCircle } from "lucide-react";
import { useIntegrationUi } from "#src/components/integration-ui-provider";
import { cn } from "@wfgraph/shared/utils";

interface IntegrationIconProps {
  integration: string;
  className?: string;
}

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
  const integrationUi = useIntegrationUi();

  const SpecialIcon = SPECIAL_ICONS[integration];
  if (SpecialIcon) {
    return <SpecialIcon className={cn("text-foreground", className)} />;
  }

  const ui = integrationUi[integration];

  if (ui) {
    const PluginIcon = ui.icon;
    return <PluginIcon className={cn("text-foreground", className)} />;
  }

  return <HelpCircle className={cn("text-foreground", className)} />;
}
