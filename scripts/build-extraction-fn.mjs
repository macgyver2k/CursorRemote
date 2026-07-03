import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { extractionFunction } from "../src/server/dom-extractor.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "server");
const outFile = join(outDir, "extraction-fn.json");

mkdirSync(outDir, { recursive: true });

const source = extractionFunction.toString();
writeFileSync(outFile, JSON.stringify(source));

console.log(
  `[build-extraction-fn] ${source.length} bytes -> dist/server/extraction-fn.json`,
);
