import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

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

const resolveToasterTheme = (value: unknown): ToasterProps["theme"] => {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

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
      theme={resolveToasterTheme(theme)}
      {...props}
    />
  );
};

export { Toaster };
