"use client";

import { useId, useRef, useState } from "react";
import { searchCountries, type CountryFeature } from "@/lib/geo";

interface Props {
  countries: CountryFeature[];
  onSelect: (code: string) => void;
}

// A small combobox: type a country name, pick with the mouse or arrow keys.
export default function CountrySearch({ countries, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const results = open ? searchCountries(countries, query) : [];

  const choose = (f: CountryFeature) => {
    onSelect(f.properties.code);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (open && (query || results.length)) {
        // Close the list first; a second Escape reaches the page and deselects.
        e.preventDefault();
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search for a country
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-sm focus-within:border-accent">
        <SearchIcon />
        <input
          id={`${listId}-input`}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && results[active] ? `${listId}-${results[active].properties.code}` : undefined
          }
          autoComplete="off"
          placeholder="Search for a country"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0); // highlight the first row of the new results
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
        />
      </div>

      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-lg border border-line bg-card py-1 shadow-sm"
        >
          {results.map((f, i) => (
            <li
              key={f.properties.code}
              id={`${listId}-${f.properties.code}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()} // keep focus on the input
              onClick={() => choose(f)}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === active ? "bg-paper text-ink" : "text-ink/80"
              }`}
            >
              {f.properties.name}
              {f.properties.admin !== f.properties.name && (
                <span className="ml-2 text-xs text-muted">{f.properties.admin}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="shrink-0 text-muted"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
