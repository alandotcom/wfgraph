import { Inngest } from "inngest";

function getInngestBaseUrl() {
  const candidates = [process.env.INNGEST_BASE_URL, process.env.INNGEST_DEV];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      new URL(candidate);
      return candidate;
    } catch {
      // Ignore non-URL values such as INNGEST_DEV=1.
    }
  }

  return;
}

export const inngest = new Inngest({
  id: "notifications-workflow",
  isDev: process.env.NODE_ENV !== "production",
  baseUrl: getInngestBaseUrl(),
});
