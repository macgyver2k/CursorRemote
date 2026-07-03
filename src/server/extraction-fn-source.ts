import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

let cached: string | null = null;

function extractionFnCandidates(): string[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  return [
    join(dir, "extraction-fn.json"),
    join(dir, "..", "..", "dist", "server", "extraction-fn.json"),
  ];
}

export function loadExtractionFunctionSource(): string {
  if (cached) return cached;

  let lastError: unknown;
  for (const jsonPath of extractionFnCandidates()) {
    try {
      cached = JSON.parse(readFileSync(jsonPath, "utf-8")) as string;
      return cached;
    } catch (err) {
      lastError = err;
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Missing extraction-fn.json (${message}). Run: pnpm exec tsx scripts/build-extraction-fn.mjs`,
  );
}
