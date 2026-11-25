import { useSetAtom } from "jotai";
import { ChevronDown, Keyboard, Moon, Plug, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { IntegrationsOverlay } from "#src/components/overlays/integrations-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import { can } from "#src/lib/authorization";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { SHORTCUT_REFERENCE_KEY } from "#src/lib/shortcut-label";
import { shortcutReferenceOpenAtom } from "#src/lib/shortcut-reference-store";

/**
 * Settings: what is about the app rather than the open workflow, which is
 * Connections, Theme and the keyboard shortcut reference.
 */
export const UserMenu = () => {
  const { theme, setTheme } = useTheme();
  const { open: openOverlay } = useOverlay();
  const openShortcutReference = useSetAtom(shortcutReferenceOpenAtom);

  return (
    <DropdownMenu>
      {/* Below `md` the trigger is its icon, so the workflow's name beside it
          keeps the room; the accessible name stays "Settings". */}
      <DropdownMenuTrigger
        render={<Button aria-label="Settings" variant="ghost" />}
      >
        <Settings className="md:hidden" />
        <span className="hidden md:inline">Settings</span>
        <ChevronDown
          className="hidden size-3 opacity-50 md:inline"
          data-icon="inline-end"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {can(WfGraphOperations.integrationGetAll.id) ? (
          <DropdownMenuItem onClick={() => openOverlay(IntegrationsOverlay)}>
            <Plug className="size-4" />
            <span>Connections</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sun className="size-4 rotate-0 scale-100 opacity-100 transition-[transform,opacity] duration-160 ease-[cubic-bezier(0.23,1,0.32,1)] dark:-rotate-90 dark:scale-[0.95] dark:opacity-0 motion-reduce:rotate-0 motion-reduce:scale-100 motion-reduce:transition-opacity dark:motion-reduce:rotate-0 dark:motion-reduce:scale-100" />
            <Moon className="absolute size-4 rotate-90 scale-[0.95] opacity-0 transition-[transform,opacity] duration-160 ease-[cubic-bezier(0.23,1,0.32,1)] dark:rotate-0 dark:scale-100 dark:opacity-100 motion-reduce:rotate-0 motion-reduce:scale-100 motion-reduce:transition-opacity dark:motion-reduce:rotate-0 dark:motion-reduce:scale-100" />
            <span>Theme</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup onValueChange={setTheme} value={theme}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => openShortcutReference(true)}>
          <Keyboard className="size-4" />
          <span>Keyboard shortcuts</span>
          <DropdownMenuShortcut>{SHORTCUT_REFERENCE_KEY}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
