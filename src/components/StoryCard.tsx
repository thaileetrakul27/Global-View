import type { Axis, Story } from "@/lib/data";
import { blindspotSide, countBalance } from "@/lib/stories";
import ArticleRow from "./ArticleRow";
import BalanceBar from "./BalanceBar";

interface Props {
  story: Story;
  axis: Axis;
}

// One story: its title, how its coverage splits, and the outlets covering it.
export default function StoryCard({ story, axis }: Props) {
  const missing = story.blindspot ? blindspotSide(story.articles, axis) : null;

  return (
    <article className="rounded-lg border border-line bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-serif text-lg leading-snug text-ink">{story.title}</h3>
        {story.blindspot && (
          <span
            title={missing ? `No ${missing} outlets covered this story` : undefined}
            className="mt-0.5 shrink-0 rounded-full border border-ink/25 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-ink"
          >
            Blindspot
          </span>
        )}
      </div>

      <div className="mt-3">
        <BalanceBar balance={countBalance(story.articles)} axis={axis} size="sm" />
      </div>

      <ul className="mt-3">
        {story.articles.map((a) => (
          <ArticleRow key={a.url} article={a} axis={axis} />
        ))}
      </ul>
    </article>
  );
}
