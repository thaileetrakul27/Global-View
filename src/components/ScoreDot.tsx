import type { Score } from "@/lib/data";

const DOT_CLASS: Record<string, string> = {
  "-2": "bg-spectrum-n2",
  "-1": "bg-spectrum-n1",
  "0": "bg-spectrum-0",
  "1": "bg-spectrum-p1",
  "2": "bg-spectrum-p2",
};

// A small coloured dot for a score. Null (unclear or unrated) is an empty ring,
// so colour never implies a reading that does not exist.
export default function ScoreDot({ score }: { score: Score | null }) {
  if (score === null) {
    return <span aria-hidden className="inline-block size-2.5 rounded-full border border-muted/60" />;
  }
  return <span aria-hidden className={`inline-block size-2.5 rounded-full ${DOT_CLASS[String(score)]}`} />;
}
