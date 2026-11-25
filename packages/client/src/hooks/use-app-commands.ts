import { useSetAtom } from "jotai";
import {
  Keyboard,
  Monitor,
  Moon,
  Plug,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { IntegrationsOverlay } from "#src/components/overlays/integrations-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { can } from "#src/lib/authorization";
import { SHORTCUT_REFERENCE_KEY } from "#src/lib/shortcut-label";
import { shortcutReferenceOpenAtom } from "#src/lib/shortcut-reference-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";

/**
 * A command a palette lists beside the editor's own: a menu row reached by
 * name. Its label is the words the menu row uses.
 */
export type PaletteMenuCommand = {
  readonly id: string;
  readonly label: string;
  /** A fact the label cannot carry, such as which theme is on now. */
  readonly detail?: string | undefined;
  readonly keywords: string;
  /** The command's shortcut, drawn as a keycap. */
  readonly hint?: string | undefined;
  readonly disabled: boolean;
  readonly Icon: LucideIcon;
  readonly execute: () => void;
};

const THEMES = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * The Settings menu's rows and the shortcut reference, as commands. Both the
 * workflows page palette and the editor's palette list them, so the two pages
 * reach Connections, Theme and the shortcut reference the same way.
 */
export function useSettingsCommands(): readonly PaletteMenuCommand[] {
  const { theme, setTheme } = useTheme();
  const { open: openOverlay } = useOverlay();
  const openShortcutReference = useSetAtom(shortcutReferenceOpenAtom);

  return [
    ...(can(WfGraphOperations.integrationGetAll.id)
      ? [
          {
            id: "connections",
            label: "Connections",
            keywords: "Connections integrations credentials accounts settings",
            disabled: false,
            Icon: Plug,
            execute: () => openOverlay(IntegrationsOverlay),
          },
        ]
      : []),
    ...THEMES.map((choice) => ({
      id: `theme-${choice.value}`,
      label: `Theme: ${choice.label}`,
      detail: theme === choice.value ? "Current" : undefined,
      keywords: `Theme ${choice.label} appearance mode color settings`,
      disabled: false,
      Icon: choice.Icon,
      execute: () => setTheme(choice.value),
    })),
    {
      id: "keyboard-shortcuts",
      label: "Keyboard shortcuts",
      keywords: "Keyboard shortcuts keys hotkeys cheat sheet help",
      hint: SHORTCUT_REFERENCE_KEY,
      disabled: false,
      Icon: Keyboard,
      execute: () => openShortcutReference(true),
    },
  ];
}
