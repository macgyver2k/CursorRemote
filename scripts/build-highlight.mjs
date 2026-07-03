import * as esbuild from "esbuild";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "src", "client", "vendor-highlight.min.js");

await esbuild.build({
  entryPoints: [join(root, "scripts", "highlight-bundle-entry.mjs")],
  bundle: true,
  format: "iife",
  globalName: "hljsModule",
  outfile,
  minify: true,
  legalComments: "none",
  footer: {
    js: "var hljs = hljsModule.default || hljsModule;",
  },
});

console.log("Built", outfile);
