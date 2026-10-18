// Compact money and people figures for the help block.

/** "$2.9B", "CHF 50M", "$90.8k". */
export function money(amount: number, currency: "USD" | "CHF"): string {
  const abs = Math.abs(amount);
  const figure =
    abs >= 1e9 ? `${(amount / 1e9).toFixed(1).replace(/\.0$/, "")}B` : abs >= 1e6 ? `${(amount / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : abs >= 1e3 ? `${(amount / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k` : `${Math.round(amount)}`;
  return currency === "USD" ? `$${figure}` : `CHF ${figure}`;
}

/** Funded share as a whole percentage, clamped to 0..100. */
export function percent(funded: number, required: number): number {
  if (required <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((funded / required) * 100)));
}

/** "50,000" style count. */
export function count(n: number): string {
  return n.toLocaleString("en-GB");
}
