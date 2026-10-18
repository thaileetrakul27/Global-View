import type { Article } from "@/lib/data";
import { shortRelativeTime } from "@/lib/time";

interface Props {
  articles: Article[];
  /** For each article link, how many countries share its story. */
  sharedCounts?: Map<string, number>;
}

/** True when a translation adds nothing (same headline in English already). */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return norm(a) === norm(b);
}

// The ranked list of a country's most popular articles. The original
// headline leads; its English translation sits under it when it differs.
export default function ArticleList({ articles, sharedCounts }: Props) {
  return (
    <ol className="divide-y divide-line">
      {articles.map((a, i) => {
        const shared = sharedCounts?.get(a.url);
        const translation = a.en && !sameText(a.en, a.title) ? a.en : null;
        return (
          <li key={a.url}>
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="w-6 shrink-0 pt-0.5 text-right font-serif text-sm tabular-nums text-muted">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-serif text-[1.05rem] leading-snug text-ink group-hover:text-accent">
                  {a.title}
                </span>
                {translation && (
                  <span className="mt-1 block text-sm leading-snug text-muted">{translation}</span>
                )}
                <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span className="truncate">{a.outlet}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={a.published} className="shrink-0">
                    {shortRelativeTime(a.published)}
                  </time>
                  {shared && shared > 1 && (
                    <span className="rounded-full border border-accent/40 px-1.5 py-px text-[11px] text-accent">
                      Read in {shared} countries
                    </span>
                  )}
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
