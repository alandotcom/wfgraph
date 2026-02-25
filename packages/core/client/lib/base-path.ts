const TRAILING_SLASH_RE = /\/$/;

export function getBasePath(): string {
  if (typeof document === "undefined") {
    return "";
  }
  const base = document.querySelector("base")?.getAttribute("href");
  if (!base) {
    return "";
  }
  return base.replace(TRAILING_SLASH_RE, "");
}
