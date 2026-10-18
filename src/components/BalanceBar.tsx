import type { Axis, Balance } from "@/lib/data";
import { SCORES, scoreLabel } from "@/lib/stories";

interface Props {
  balance: Balance;
  axis: Axis;
  /** Compact bars (story cards) drop the end labels. */
  size?: "sm" | "lg";
}

const SEGMENT_CLASS: Record<string, string> = {
  "-2": "bg-spectrum-n2",
  "-1": "bg-spectrum-n1",
  "0": "bg-spectrum-0",
  "1": "bg-spectrum-p1",
  "2": "bg-spectrum-p2",
};

// A stacked bar: teal on the left end of the axis, grey in the centre, amber
// on the right, with a pale segment for articles that could not be scored.
export default function BalanceBar({ balance, axis, size = "lg" }: Props) {
  const total =
    SCORES.reduce<number>((n, s) => n + balance[String(s) as keyof Balance], 0) + balance.unclear;
  if (total === 0) return null;

  const parts = SCORES.map((s) => ({
    key: String(s),
    n: balance[String(s) as keyof Balance],
    label: scoreLabel(s, axis),
  }));

  const summary = parts
    .filter((p) => p.n > 0)
    .map((p) => `${p.n} ${p.label.toLowerCase()}`)
    .concat(balance.unclear ? [`${balance.unclear} unclear`] : [])
    .join(", ");

  return (
    <div>
      <div
        role="img"
        aria-label={`Coverage balance: ${summary}`}
        className={`flex overflow-hidden rounded-full bg-line ${size === "lg" ? "h-2.5" : "h-1.5"}`}
      >
        {parts.map(
          (p) =>
            p.n > 0 && (
              <div
                key={p.key}
                className={SEGMENT_CLASS[p.key]}
                style={{ width: `${(p.n / total) * 100}%` }}
              />
            ),
        )}
        {balance.unclear > 0 && (
          <div
            className="bg-line"
            style={{ width: `${(balance.unclear / total) * 100}%` }}
          />
        )}
      </div>
      {size === "lg" && (
        <div className="mt-1.5 flex justify-between gap-4 text-xs text-muted">
          <span className="capitalize">{axis.left}</span>
          <span className="capitalize">{axis.right}</span>
        </div>
      )}
    </div>
  );
}
