// Command-line flags for the update script.

export interface UpdateArgs {
  /** ISO codes to fetch, upper-cased. Undefined means every enabled country. */
  countries?: string[];
  /** Most articles kept per country. */
  maxArticles: number;
  /** Minimum wait between feed requests, in milliseconds. */
  delayMs: number;
  /** Directory the website reads from. */
  outDir: string;
  /** Skip translation and story grouping even when credentials exist. */
  noAi: boolean;
}

export const DEFAULT_UPDATE_ARGS: UpdateArgs = {
  maxArticles: 30,
  delayMs: 2000,
  outDir: "public/data",
  noAi: false,
};

/**
 * Parses `--flag value` and `--flag=value` pairs. Unknown flags throw so a
 * typo never silently runs the whole pipeline with defaults.
 */
export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const args: UpdateArgs = { ...DEFAULT_UPDATE_ARGS };
  for (const [flag, value] of toPairs(argv)) {
    switch (flag) {
      case "countries":
        args.countries = value
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        break;
      case "max":
        args.maxArticles = positiveInt(flag, value);
        break;
      case "delay":
        args.delayMs = positiveInt(flag, value);
        break;
      case "out":
        args.outDir = value;
        break;
      case "no-ai":
        args.noAi = true;
        break;
      default:
        throw new Error(`Unknown flag --${flag}`);
    }
  }
  return args;
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["no-ai"]);

function toPairs(argv: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    if (BOOLEAN_FLAGS.has(a.slice(2))) {
      pairs.push([a.slice(2), "true"]);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) {
      pairs.push([a.slice(2, eq), a.slice(eq + 1)]);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Flag ${a} needs a value`);
      pairs.push([a.slice(2), next]);
      i++;
    }
  }
  return pairs;
}

function positiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${flag} must be a positive whole number`);
  return n;
}
