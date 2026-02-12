import * as React from "react";

export function AcuityIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="17"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8 2.8v3.4M16 2.8v3.4M3.8 9.2h16.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 13.2 10.2 16h3.6L12 13.2ZM9.4 13.2H7.9L10.6 9h2.8l2.7 4.2h-1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
