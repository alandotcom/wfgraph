import * as stylex from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars } from "@astryxdesign/core/theme/tokens.stylex";
import { Database, HelpCircle } from "lucide-react";
import { useIntegrationUi } from "#src/components/integration-ui-provider";

export function IntegrationIcon({ integration }: { integration: string }) {
  const integrationUi = useIntegrationUi();

  if (integration === "database") {
    return <Icon icon={Database} size="sm" />;
  }

  const ui = integrationUi[integration];
  if (ui) {
    const PluginIcon = ui.icon;
    return <PluginIcon className={stylex.props(styles.icon).className} />;
  }

  return <Icon icon={HelpCircle} size="sm" />;
}

const styles = stylex.create({
  icon: { color: colorVars["--color-text-primary"], height: 16, width: 16 },
});
