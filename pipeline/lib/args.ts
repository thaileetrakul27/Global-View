// Command-line flags for the pipeline scripts.

export interface FetchArgs {
  /** ISO codes to fetch, upper-cased. Undefined means every enabled country. */
  countries?: string[];
  /** GDELT timespan, e.g. "12h". */
  timespan: string;
  /** Most records to ask GDELT for per country (GDELT caps at 250). */
  maxRecords: number;
  /** Minimum wait between GDELT requests, in milliseconds. */
  delayMs: number;
  /** Directory for raw results. */
  outDir: string;
}

export const DEFAULT_FETCH_ARGS: FetchArgs = {
  timespan: "12h",
  maxRecords: 75,
  delayMs: 5000,
  outDir: "pipeline/out/raw",
};

/**
 * Parses `--flag value` and `--flag=value` pairs. Unknown flags throw so a
 * typo never silently runs the whole pipeline with defaults.
 */
export function parseFetchArgs(argv: string[]): FetchArgs {
  const args: FetchArgs = { ...DEFAULT_FETCH_ARGS };
  const pairs = toPairs(argv);
  for (const [flag, value] of pairs) {
    switch (flag) {
      case "countries":
        args.countries = value
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean);
        break;
      case "timespan":
        args.timespan = value;
        break;
      case "max":
        args.maxRecords = positiveInt(flag, value);
        break;
      case "delay":
        args.delayMs = positiveInt(flag, value);
        break;
      case "out":
        args.outDir = value;
        break;
      default:
        throw new Error(`Unknown flag --${flag}`);
    }
  }
  return args;
}

function toPairs(argv: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
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
