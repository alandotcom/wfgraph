import { cn } from "@rova/shared/utils";

type CodeEditorOptions = {
  readOnly?: boolean;
  domReadOnly?: boolean;
  wordWrap?: "on" | "off";
  [key: string]: unknown;
};

export type CodeEditorProps = {
  className?: string;
  defaultLanguage?: string;
  height?: number | string;
  /** Forwarded to the textarea so a `<Label htmlFor>` can reach it. */
  id?: string;
  /** Accessible name for editors that have no visible label. */
  "aria-label"?: string;
  onChange?: (value: string | undefined) => void;
  options?: CodeEditorOptions;
  value?: string;
};

export function CodeEditor({
  className,
  defaultLanguage,
  height,
  id,
  "aria-label": ariaLabel,
  onChange,
  options,
  value,
}: CodeEditorProps) {
  const isReadOnly = Boolean(options?.readOnly || options?.domReadOnly);
  const normalizedHeight =
    typeof height === "number" ? `${height}px` : (height ?? "140px");

  return (
    <textarea
      aria-label={ariaLabel}
      id={id}
      className={cn(
        "w-full resize-y bg-background px-3 py-2 font-mono text-sm outline-none",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      data-code-editor="true"
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={
        defaultLanguage ? `${defaultLanguage.toUpperCase()}...` : undefined
      }
      readOnly={isReadOnly}
      spellCheck={false}
      style={{
        height: normalizedHeight,
        whiteSpace: options?.wordWrap === "on" ? "pre-wrap" : "pre",
      }}
      value={value ?? ""}
    />
  );
}
