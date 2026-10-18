import type { Article } from "@/lib/data";
import { shortRelativeTime } from "@/lib/time";

// The ranked list of a country's most popular articles. Each row links out
// to the publisher; nothing is shown beyond headline, outlet and time.
export default function ArticleList({ articles }: { articles: Article[] }) {
  return (
    <ol className="divide-y divide-line">
      {articles.map((a, i) => (
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
              <span className="mt-1 flex items-center gap-2 text-xs text-muted">
                <span className="truncate">{a.outlet}</span>
                <span aria-hidden>·</span>
                <time dateTime={a.published} className="shrink-0">
                  {shortRelativeTime(a.published)}
                </time>
              </span>
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
