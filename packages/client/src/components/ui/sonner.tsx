import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useColorMode } from "#src/theme/color-mode";

type ToasterStyle = React.CSSProperties &
  Record<
    "--normal-bg" | "--normal-text" | "--normal-border" | "--border-radius",
    string
  >;

const toasterStyle: ToasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
};

const Toaster = ({ ...props }: ToasterProps) => {
  // The resolved mode, so sonner never re-resolves "system" against its own
  // media query and disagrees with the Theme provider by a frame.
  const { resolvedMode } = useColorMode();

  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={toasterStyle}
      theme={resolvedMode}
      {...props}
    />
  );
};

export { Toaster };
