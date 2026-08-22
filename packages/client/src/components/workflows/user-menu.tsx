import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { Check, Key, Moon, Plug, Sun } from "lucide-react";
import { ApiKeysOverlay } from "#src/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "#src/components/overlays/integrations-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { useColorMode } from "#src/theme/color-mode";

export const UserMenu = () => {
  const { mode, setMode } = useColorMode();
  const { open: openOverlay } = useOverlay();

  const selected = <Icon color="accent" icon={Check} size="sm" />;

  return (
    <DropdownMenu
      alignment="end"
      button={{ label: "Settings", variant: "secondary" }}
      items={[
        {
          icon: Plug,
          label: "Connections",
          onClick: () => openOverlay(IntegrationsOverlay),
        },
        {
          icon: Key,
          label: "API keys",
          onClick: () => openOverlay(ApiKeysOverlay),
        },
        { type: "divider" },
        {
          type: "section",
          title: "Theme",
          items: [
            {
              endContent: mode === "light" ? selected : undefined,
              icon: Sun,
              label: "Light",
              onClick: () => setMode("light"),
            },
            {
              endContent: mode === "dark" ? selected : undefined,
              icon: Moon,
              label: "Dark",
              onClick: () => setMode("dark"),
            },
            {
              endContent: mode === "system" ? selected : undefined,
              label: "System",
              onClick: () => setMode("system"),
            },
          ],
        },
      ]}
      menuWidth={224}
    />
  );
};
