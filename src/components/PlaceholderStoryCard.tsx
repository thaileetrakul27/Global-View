// A grey-bar stand-in for a story card, so the panel layout can be judged
// before any real data exists. `seed` varies the bar lengths slightly.
export default function PlaceholderStoryCard({ seed = 0 }: { seed?: number }) {
  const widths = [["w-11/12", "w-2/3"], ["w-3/4", "w-5/6"], ["w-5/6", "w-1/2"]][seed % 3];
  return (
    <article
      aria-label="Placeholder story"
      className="rounded-lg border border-line bg-card p-4"
    >
      <div className={`h-3.5 rounded bg-line ${widths[0]}`} />
      <div className={`mt-2 h-3.5 rounded bg-line ${widths[1]}`} />

      {/* Story balance bar: teal, grey, amber, muted until real counts exist */}
      <div className="mt-4 flex h-1.5 overflow-hidden rounded-full">
        <div className="w-[30%] bg-spectrum-n1/40" />
        <div className="w-[40%] bg-spectrum-0/40" />
        <div className="w-[30%] bg-spectrum-p1/40" />
      </div>

      <div className="mt-3 flex gap-2">
        <div className="h-5 w-20 rounded-full bg-line" />
        <div className="h-5 w-16 rounded-full bg-line" />
        <div className="h-5 w-24 rounded-full bg-line" />
      </div>
    </article>
  );
}
