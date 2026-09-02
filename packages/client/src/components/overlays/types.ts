import type { ComponentType, ReactNode } from "react";

/**
 * Button variant types matching shadcn/ui Button
 */
export type OverlayActionVariant =
  | "default"
  | "destructive"
  | "outline"
  | "secondary"
  | "ghost"
  | "link";

/**
 * Action button configuration for overlay footer
 */
export type OverlayAction = {
  label: string;
  onClick: () => void;
  variant?: OverlayActionVariant | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
};

/**
 * Configuration options when opening an overlay
 */
export type OverlayOptions = {
  /** Title displayed in the header */
  title?: string | undefined;
  /** Description displayed below the title */
  description?: string | undefined;
  /** Action buttons for the footer */
  actions?: OverlayAction[] | undefined;
  /** Whether clicking the backdrop closes the overlay (default: true) */
  closeOnBackdropClick?: boolean | undefined;
  /** Whether pressing Escape closes the overlay (default: true) */
  closeOnEscape?: boolean | undefined;
  /** Callback when overlay is closed */
  onClose?: (() => void) | undefined;
};

/**
 * Props passed to overlay components
 */
export type OverlayComponentProps<P = Record<string, unknown>> = P & {
  /** Unique identifier for this overlay instance */
  overlayId: string;
};

/**
 * A single item in the overlay stack
 */
export type OverlayStackItem<P = Record<string, unknown>> = {
  /** Unique identifier for this overlay instance */
  id: string;
  /** The component to render */
  component: ComponentType<OverlayComponentProps<P>>;
  /** Props to pass to the component */
  props: P;
  /** Configuration options */
  options: OverlayOptions;
};

/**
 * The overlay context value exposed by useOverlay()
 */
export type OverlayContextValue = {
  /** Current stack of overlays */
  stack: OverlayStackItem[];
  /** Open a new overlay, replacing any existing stack */
  open: <P extends Record<string, unknown>>(
    component: ComponentType<OverlayComponentProps<P>>,
    props?: P,
    options?: OverlayOptions
  ) => string;
  /** Push a new overlay onto the stack (shows back button) */
  push: <P extends Record<string, unknown>>(
    component: ComponentType<OverlayComponentProps<P>>,
    props?: P,
    options?: OverlayOptions
  ) => string;
  /** Pop the top overlay from the stack */
  pop: () => void;
  /** Replace the current overlay with a new one */
  replace: <P extends Record<string, unknown>>(
    component: ComponentType<OverlayComponentProps<P>>,
    props?: P,
    options?: OverlayOptions
  ) => string;
  /** Close all overlays */
  closeAll: () => void;
  /** Close a specific overlay by ID */
  close: (id: string) => void;
  /** Check if there are overlays in the stack */
  hasOverlays: boolean;
  /** Get the depth of the current overlay (0 = first, 1+ = pushed) */
  depth: number;
};

/**
 * Props for the base Overlay component
 */
export type OverlayProps = {
  /** Title displayed in the header */
  title?: string | undefined;
  /** Description displayed below the title */
  description?: string | undefined;
  /** Action buttons for the footer */
  actions?: OverlayAction[] | undefined;
  /** Content to render inside the overlay */
  children?: ReactNode;
  /** Additional class name for the content container */
  className?: string | undefined;
};

/**
 * Props for OverlayHeader component
 */
export type OverlayHeaderProps = {
  /** Title text */
  title?: string | undefined;
  /** Description text */
  description?: string | undefined;
  /** Whether to show the back button */
  showBackButton?: boolean | undefined;
  /** Whether to show the close button */
  showCloseButton?: boolean | undefined;
  /** Custom back button handler (defaults to pop) */
  onBack?: (() => void) | undefined;
  /** Custom close button handler (defaults to closeAll) */
  onClose?: (() => void) | undefined;
  /** Extra controls, such as Runs Refresh / Clear All, trailing the title. */
  trailing?: ReactNode;
  /** Additional class name */
  className?: string | undefined;
};

/**
 * Props for OverlayFooter component
 */
export type OverlayFooterProps = {
  /** Action buttons to render */
  actions?: OverlayAction[] | undefined;
  /** Additional class name */
  className?: string | undefined;
  /** Children to render (alternative to actions) */
  children?: ReactNode;
};
