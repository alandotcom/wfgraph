import { ChevronDown, Key, Moon, Plug, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { ApiKeysOverlay } from "#src/components/overlays/api-keys-overlay";
import { IntegrationsOverlay } from "#src/components/overlays/integrations-overlay";
import { useOverlay } from "#src/components/overlays/overlay-provider";
import { Button } from "#src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";

export const UserMenu = () => {
  const { theme, setTheme } = useTheme();
  const { open: openOverlay } = useOverlay();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" />}>
        Settings
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => openOverlay(IntegrationsOverlay)}>
          <Plug className="size-4" />
          <span>Connections</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openOverlay(ApiKeysOverlay)}>
          <Key className="size-4" />
          <span>API Keys</span>
        </DropdownMenuItem>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
