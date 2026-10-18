import type { Article } from "@/lib/data";
import { shortRelativeTime } from "@/lib/time";

export interface SharedRef {
  id: string;
  count: number;
}

interface Props {
  articles: Article[];
  /** For each article link, the shared story it belongs to. */
  shared?: Map<string, SharedRef>;
  /** Opens a shared story's panel. */
  onStory?: (id: string) => void;
}

/** True when a translation adds nothing (same headline in English already). */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return norm(a) === norm(b);
}

// The ranked list of a country's most popular articles. The original
// headline leads; its English translation sits under it when it differs.
// Articles in a shared story carry a badge that opens that story.
export default function ArticleList({ articles, shared, onStory }: Props) {
  return (
    <ol className="divide-y divide-line">
      {articles.map((a, i) => {
        const ref = shared?.get(a.url);
        const translation = a.en && !sameText(a.en, a.title) ? a.en : null;
        return (
          <li key={a.url} className="flex gap-3 py-3">
            <span className="w-6 shrink-0 pt-0.5 text-right font-serif text-sm tabular-nums text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="block font-serif text-[1.05rem] leading-snug text-ink group-hover:text-accent">{a.title}</span>
                {translation && <span className="mt-1 block text-sm leading-snug text-muted">{translation}</span>}
              </a>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className="truncate">{a.outlet}</span>
                {a.published && (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={a.published} className="shrink-0">
                      {shortRelativeTime(a.published)}
                    </time>
                  </>
                )}
                {ref && ref.count > 1 && onStory && (
                  <button
                    type="button"
                    onClick={() => onStory(ref.id)}
                    className="rounded-full border border-accent/40 px-1.5 py-px text-[11px] text-accent hover:bg-accent hover:text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Read in {ref.count} countries
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
