import React from "react";

export function TwilioIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Twilio"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Twilio</title>
      <circle cx="12" cy="12" fill="currentColor" r="10" />
      <circle cx="9" cy="9" fill="white" r="2" />
      <circle cx="15" cy="9" fill="white" r="2" />
      <circle cx="9" cy="15" fill="white" r="2" />
      <circle cx="15" cy="15" fill="white" r="2" />
    </svg>
  );
}
