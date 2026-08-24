import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Sonner's surface variables are CSS custom properties, which `CSSProperties`
 * does not admit on its own. Local addition, re-apply after a `shadcn add
 * sonner`: the registry component asserts the object into place instead, and
 * this repo refuses an unsafe assertion.
 */
type ToasterStyle = React.CSSProperties &
  Record<
    "--normal-bg" | "--normal-text" | "--normal-border" | "--border-radius",
    string
  >

const toasterStyle: ToasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
}

/** next-themes reports any stored string; three of them mean something here. */
const resolveToasterTheme = (value: unknown): ToasterProps["theme"] => {
  if (value === "light" || value === "dark" || value === "system") {
    return value
  }
  return "system"
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={resolveToasterTheme(theme)}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
        ),
      }}
      style={toasterStyle}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
