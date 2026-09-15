/**
 * Editor preferences that survive a reload, kept in cookies for one year. Each
 * preference is read once as an atom's initial value and written from that
 * atom's own setter. `readCookie` answers undefined outside a browser.
 */

const COOKIE_MAX_AGE_SECONDS = 31_536_000; // one year

export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  return document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`))
    ?.split("=")[1];
}

export function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
}
