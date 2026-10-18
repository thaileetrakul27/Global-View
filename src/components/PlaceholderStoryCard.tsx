// Grey bars standing in for an article row while a country's list loads.
export default function PlaceholderStoryCard({ seed = 0 }: { seed?: number }) {
  const widths = ["w-11/12", "w-3/4", "w-5/6", "w-2/3"][seed % 4];
  return (
    <div aria-hidden className="flex gap-3 py-3">
      <div className="h-3.5 w-6 rounded bg-line" />
      <div className="flex-1">
        <div className={`h-4 rounded bg-line ${widths}`} />
        <div className="mt-2 h-3 w-1/3 rounded bg-line" />
      </div>
    </div>
  );
}
