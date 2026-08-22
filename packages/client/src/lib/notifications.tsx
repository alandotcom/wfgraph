import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { useDomEvent } from "#src/hooks/effects";

type NotificationDetail = { body: string; type?: "info" | "error" };
const EVENT_NAME = "wfgraph:notification";

function show(detail: NotificationDetail): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<NotificationDetail>(EVENT_NAME, { detail })
    );
  }
}

export const notifications = {
  success: (body: string) => show({ body }),
  message: (body: string) => show({ body }),
  error: (body: string) => show({ body, type: "error" }),
};

function NotificationListener() {
  const showToast = useToast();
  useDomEvent(window, EVENT_NAME, (event) => {
    if (event instanceof CustomEvent) {
      const detail: unknown = event.detail;
      if (
        typeof detail === "object" &&
        detail !== null &&
        "body" in detail &&
        typeof detail.body === "string"
      ) {
        showToast({
          body: detail.body,
          type: "type" in detail && detail.type === "error" ? "error" : "info",
        });
      }
    }
  });
  return null;
}

export function NotificationViewport() {
  return (
    <ToastViewport position="bottomEnd">
      <NotificationListener />
    </ToastViewport>
  );
}
