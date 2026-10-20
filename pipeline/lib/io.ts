import fs from "node:fs";
import path from "node:path";

/**
 * Writes text through a temporary file and a rename, so a run killed
 * mid-write (the job's time limit) leaves the old file or the new one,
 * never half of either. Parent folders are created as needed.
 */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Writes pretty JSON, atomically. */
export function writeJson(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

/** Writes JSON on one line, atomically: for large machine-read files such as map geometry, where indentation would triple the size. */
export function writeCompactJson(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data) + "\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
