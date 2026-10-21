"use client";

interface Props {
  onOpen: () => void;
}

// Phones: a small button under the search row that opens "Trending today"
// in the bottom sheet. Focus comes back to it when the sheet closes.
export default function TrendingButton({ onOpen }: Props) {
  return (
    <button
      type="button"
      data-trending-button
      onClick={onOpen}
      className="pointer-events-auto inline-flex h-10 items-center gap-1.5 self-start rounded-full border border-line bg-card/90 px-3.5 text-sm text-ink backdrop-blur-sm hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
        <path d="M3 17l6-6 4 4 8-8" />
        <path d="M15 7h6v6" />
      </svg>
      Trending today
    </button>
  );
}
