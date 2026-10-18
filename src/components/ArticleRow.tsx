"use client";

import { useState } from "react";
import type { Article, Axis } from "@/lib/data";
import { effectiveScore, outletLabel, outletName, scoreLabel } from "@/lib/stories";
import ScoreDot from "./ScoreDot";

interface Props {
  article: Article;
  axis: Axis;
}

// One outlet line inside a story card. Tapping it reveals the reason sentence,
// the outlet's stored rating and a link to the article.
export default function ArticleRow({ article, axis }: Props) {
  const [open, setOpen] = useState(false);
  const score = effectiveScore(article);

  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 py-2 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ScoreDot score={score} />
        <span className="min-w-0 flex-1 truncate text-ink">{outletName(article.outlet)}</span>
        <span className={`shrink-0 text-xs ${score === null ? "italic text-muted" : "text-muted"}`}>
          {scoreLabel(score, axis)}
        </span>
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="pb-3 pl-5 text-sm">
          <p className="text-ink">{article.reason}</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted">
            <dt>Outlet rating</dt>
            <dd className="flex items-center gap-1.5">
              <ScoreDot score={article.outlet_rating} />
              {outletLabel(article.outlet_rating, axis)}
            </dd>
            <dt>Confidence</dt>
            <dd className="capitalize">{article.confidence}</dd>
            {article.headline_original !== article.headline_en && (
              <>
                <dt>Original</dt>
                <dd lang="">{article.headline_original}</dd>
              </>
            )}
          </dl>
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-xs text-accent underline-offset-2 hover:underline"
          >
            Read at {article.outlet}
          </a>
        </div>
      )}
    </li>
  );
}
