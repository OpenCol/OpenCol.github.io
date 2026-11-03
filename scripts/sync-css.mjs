// sync-css.mjs - Replaces assets/vendor/col.css with a released one.
//
//   npm run sync-css -- v1.3.0
//
// The design system lives in OpenCol/web-ui; this site keeps a copy so a page
// never depends on another site being up. Commit the result.

import { writeFile } from "node:fs/promises";

const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: npm run sync-css -- vX.Y.Z");
  process.exit(1);
}
const url = `https://github.com/OpenCol/web-ui/releases/download/${version}/col.css`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: ${res.status}`);
const css = await res.text();
await writeFile(new URL("../assets/vendor/col.css", import.meta.url),
  `/* OpenCol/web-ui ${version}, from ${url} - do not edit here; npm run sync-css. */\n${css}`);
console.log(`assets/vendor/col.css is now web-ui ${version}`);
