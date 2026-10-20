import type { ReactNode } from "react";
import { safeHref } from "@/lib/disasters";

// Shared bits for the disaster panel's links and headings.

export const ring = "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";
export const textLink = `underline decoration-line underline-offset-2 hover:decoration-accent ${ring}`;
export const heading = "text-xs font-medium uppercase tracking-wide text-muted";

/** A link to another site in a new tab, or plain text when the address is not https. */
export function External({ href, className, children }: { href: string | undefined; className?: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Arrow-out-of-box icon for links that leave the site. */
export function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
