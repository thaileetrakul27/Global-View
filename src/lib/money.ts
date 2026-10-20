// Compact money figures, such as an appeal's funding in Swiss francs.

/** "CHF 2.9B", "CHF 50M", "CHF 91k". IFRC reports appeals in Swiss francs. */
export function money(amount: number, currency: "CHF"): string {
  const abs = Math.abs(amount);
  const figure =
    abs >= 1e9 ? `${(amount / 1e9).toFixed(1).replace(/\.0$/, "")}B` : abs >= 1e6 ? `${(amount / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : abs >= 1e3 ? `${(amount / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k` : `${Math.round(amount)}`;
  return `${currency} ${figure}`;
}

/** Funded share as a whole percentage, clamped to 0..100. */
export function percent(funded: number, required: number): number {
  if (required <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((funded / required) * 100)));
}
