// build.mjs - Builds the site into _site/.
//
//   node scripts/build.mjs            fetch the releases and the CHANGELOG, build
//                                     (OPENCOL_TOKEN=$(gh auth token) while the repo is private)
//   node scripts/build.mjs --offline  build from .cache/, no network
//   node scripts/build.mjs --serve    build, then serve _site/ on :8000
//
// The pages are hand-written HTML in src/pages/, wrapped in src/layout.html.
// What changes with every OpenCol release - the version, the downloads, the
// changelog pages - is read from GitHub at build time, so a release needs no
// edit here: the Pages workflow rebuilds the site every day.
//
// A template names a value as {{name}}. A name the build does not know is an
// error, not an empty string, so a typo cannot ship a hole in a page.

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "_site");
const CACHE = join(ROOT, ".cache");
const args = new Set(process.argv.slice(2));
const site = JSON.parse(await readFile(join(ROOT, "site.json"), "utf8"));

// ---------------------------------------------------------------- data
//
// OpenCol/OpenCol may be private, so everything is read through the API with a
// token (OPENCOL_TOKEN, else GITHUB_TOKEN), and what a visitor downloads or
// sees - the latest zips, the changelog's pictures - is copied into the site
// rather than linked. Every response is cached in .cache/ for --offline.
//
// When GitHub cannot be read - the repository private and no token, as on the
// Pages workflow until OpenCol/OpenCol is public - the build falls back to
// snapshot/, a committed copy of .cache/ (npm run snapshot), and says so.

const TOKEN = process.env.OPENCOL_TOKEN || process.env.GITHUB_TOKEN;
const SNAPSHOT = join(ROOT, "snapshot");
let usedSnapshot = false;

async function api(path, accept, cacheAs) {
  const file = join(CACHE, cacheAs);
  if (args.has("--offline") || (cacheAs.startsWith("files/") && existsSync(file))) {
    return readFile(file);
  }
  const headers = { "User-Agent": "opencol.github.io", Accept: accept };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) {
    const fallback = join(SNAPSHOT, cacheAs);
    if (existsSync(fallback)) {
      if (!usedSnapshot) console.warn(`GET ${path}: ${res.status}; building from snapshot/`);
      usedSnapshot = true;
      return readFile(fallback);
    }
    const hint = res.status === 404 && !TOKEN ? " (a private repository needs OPENCOL_TOKEN)" : "";
    throw new Error(`GET ${path}: ${res.status} ${res.statusText}${hint}`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return data;
}
const repoFile = (ref, path) => api(`repos/${site.repo}/contents/${path}?ref=${ref}`,
  "application/vnd.github.raw", `files/${ref}/${path}`);

// Only the program's releases: a v-tag with zips. Test data and drafts stay out.
const releases = JSON.parse(await api(`repos/${site.repo}/releases?per_page=100`,
  "application/vnd.github+json", "releases.json"))
  .filter((r) => !r.draft && /^v\d/.test(r.tag_name) && r.assets.some((a) => a.name.endsWith(".zip")))
  .map((r) => ({
    tag: r.tag_name,
    version: r.tag_name.slice(1),
    name: r.name || r.tag_name,
    date: r.published_at.slice(0, 10),
    url: r.html_url,
    body: r.body || "",
    assets: r.assets.filter((a) => a.name.endsWith(".zip"))
      .map((a) => ({ id: a.id, name: a.name, url: a.browser_download_url, size: a.size })),
  }))
  .sort((a, b) => compareVersions(b.version, a.version));

if (!releases.length) throw new Error(`no releases found in ${site.repo}`);
const latest = releases[0];
const changelog = String(await repoFile(latest.tag, "CHANGELOG.md"));

// The latest release's zips are served from the site itself: /download/<name>.
const mirrored = [];
for (const a of latest.assets) {
  const data = await api(`repos/${site.repo}/releases/assets/${a.id}`, "application/octet-stream",
    `files/assets/${a.name}`);
  mirrored.push({ path: `download/${a.name}`, data });
  a.url = `{{root}}download/${a.name}`;
}

// Pictures the Markdown shows, collected while it is converted: [ref, path].
const media = new Map();

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- markdown

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// One converter per document: it collects the headings for the outline and
// points the repository-relative links of OpenCol's Markdown at GitHub.
function markdown(src, { tag, root }) {
  const headings = [];
  const used = new Map();
  const blob = `https://github.com/${site.repo}/blob/${tag}/`;
  const rawPrefix = `https://raw.githubusercontent.com/${site.repo}/`;
  const relative = (href) => href && !/^([a-z]+:|#|\/)/i.test(href);
  // A picture in the repository - relative, or a raw.githubusercontent link -
  // is copied to media/<ref>/<path>; any other picture is left where it is.
  const picture = (href) => {
    let ref = tag, path = null;
    if (relative(href)) path = href.replace(/^\.\//, "");
    else if (href.startsWith(rawPrefix)) [ref, ...path] = href.slice(rawPrefix.length).split("/");
    if (!path) return href;
    path = Array.isArray(path) ? path.join("/") : path;
    media.set(`${ref}/${path}`, [ref, path]);
    return `${root}media/${ref}/${path}`;
  };

  const md = new Marked({
    gfm: true,
    walkTokens(t) {
      if (t.type === "image") t.href = picture(t.href);
      if (t.type === "link" && relative(t.href)) t.href = blob + t.href.replace(/^\.\//, "");
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slugify(html) || "section";
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id += `-${n}`;
        if (depth === 2 || depth === 3) headings.push({ id, depth, html: html.replace(/<[^>]+>/g, "") });
        return `<h${depth} id="${id}">${html} <a class="col-anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      table(token) {
        // A wide before-and-after table scrolls inside its own edge.
        return `<div class="col-tablewrap"><div class="col-scroll">${Renderer.prototype.table.call(this, token)}</div></div>`;
      },
      image({ href, title, text }) {
        const t = title ? ` title="${esc(title)}"` : "";
        return `<img src="${esc(href)}" alt="${esc(text)}"${t} loading="lazy">`;
      },
    },
  });
  return { html: md.parse(src), headings };
}

// ---------------------------------------------------------------- templates

const layout = await readFile(join(ROOT, "src/layout.html"), "utf8");

function fill(tpl, values, where) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`${where}: unknown template value {{${k}}}`);
    return values[k];
  });
}

const pages = [];
function page(path, { title, description, body, nav = "" }) {
  const depth = path.split("/").length - 1;
  const root = depth ? "../".repeat(depth) : "./";
  pages.push({ path, html: { title, description, body, nav, root } });
}

function render({ path, html }) {
  // Shared values may hold links of their own; {{root}} in them is this page's.
  const common = Object.fromEntries(Object.entries(shared).map(([k, v]) => [k, v.replaceAll("{{root}}", html.root)]));
  Object.assign(common, { root: html.root, nav: html.nav });
  const body = fill(html.body, common, path);
  return fill(layout, {
    ...common,
    title: html.title,
    description: esc(html.description),
    canonical: site.url + path.replace(/index\.html$/, ""),
    content: body,
    path: path.replace(/index\.html$/, ""),
  }, "src/layout.html");
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB",
  { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function downloadButtons(release) {
  return site.downloads.map((d) => {
    const a = release.assets.find((x) => x.name.includes(d.match));
    if (!a) return "";
    return `<a class="col-btn" data-os="${d.os}" href="${esc(a.url)}">` +
      `<span><span class="site-btn-pre">Download for </span>${esc(d.label)}</span>` +
      `<span class="site-btn-meta">.zip · ${mb(a.size)}</span></a>`;
  }).join("\n      ");
}

function downloadTable(release) {
  return `<div class="col-tablewrap"><div class="col-scroll"><table class="col-table site-downloads">
        <thead><tr><th>File</th><th>For</th><th class="col-num">Size</th></tr></thead>
        <tbody>${site.downloads.map((d) => {
          const a = release.assets.find((x) => x.name.includes(d.match));
          return a ? `
          <tr><td><a href="${esc(a.url)}"><code>${esc(a.name)}</code></a></td><td>${esc(d.detail)}</td><td class="col-num">${mb(a.size)}</td></tr>` : "";
        }).join("")}
        </tbody>
      </table></div></div>`;
}

const shared = {
  name: site.name,
  siteUrl: site.url,
  version: latest.version,
  releaseDate: longDate(latest.date),
  releaseUrl: latest.url,
  releaseCount: String(releases.length),
  downloadButtons: downloadButtons(latest),
  downloadTable: downloadTable(latest),
  year: String(new Date().getUTCFullYear()),
  siteRepoUrl: `https://github.com/${site.siteRepo}`,
  ...Object.fromEntries(Object.entries(site.links).map(([k, v]) => [`${k}Url`, v])),
};

// The rules page is built from the CHANGELOG's own "The rules" section, so it
// lists every rule option the latest release has, with its default.
{
  const section = (changelog.match(/^## The rules\n([\s\S]*?)(?=^## )/m) || [])[1];
  if (!section) throw new Error("CHANGELOG.md has no '## The rules' section");
  const options = [...section.matchAll(/^- \*\*([a-z0-9-]+)\*\*(.*)$/gm)].map((m) => ({
    name: m[1], on: /on at first/.test(m[2]), proposed: /on is proposed/.test(m[2]),
  }));
  const width = Math.max(...options.map((o) => o.name.length));
  shared.rulesCount = String(options.length);
  shared.rulesIni = [
    `<span class="c">; 0 is the original's rule. Yours to change.</span>`,
    `<span class="s">[Rules]</span>`,
    ...options.map((o) => `${o.name.padEnd(width)} = ${o.on ? "<b>1</b>" : "0"}` +
      (o.proposed ? `  <span class="c">; on is proposed</span>` : "")),
  ].join("\n");
  shared.rulesHtml = markdown(section, { tag: latest.tag, root: "../" }).html.replace(/\{\{/g, "&#123;&#123;");
}

// The map archive (OpenCol/maps) is a site of its own; the landing page shows
// how many maps it holds and a few of them. Its catalogue is public. If it
// cannot be read, the build goes on from the last copy, or without the strip:
// the archive being down is no reason not to publish a release.
{
  let maps = [];
  const file = join(CACHE, "maps.json");
  try {
    if (args.has("--offline")) throw new Error("offline");
    const res = await fetch(site.maps.catalog, { headers: { "User-Agent": "opencol.github.io" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    maps = (await res.json()).maps;
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(maps));
  } catch (err) {
    const fallback = [file, join(SNAPSHOT, "maps.json")].find((f) => existsSync(f));
    if (fallback) maps = JSON.parse(await readFile(fallback, "utf8"));
    else console.warn(`maps: ${site.maps.catalog}: ${err.message}; no map strip`);
  }
  const base = site.maps.catalog.replace(/[^/]+$/, "");
  shared.mapsCount = maps.length ? String(maps.length) : "Dozens of";
  shared.mapsStrip = site.maps.featured.map((id) => maps.find((m) => m.id === id)).filter(Boolean)
    .map((m) => `
      <a class="site-map" href="${esc(site.links.maps)}">
        <img src="${esc(base + m.preview_link)}" alt="${esc(m.name)}" loading="lazy">
        <span class="site-map-t">${esc(m.name)}</span>
        <span class="col-meta">${m.size.width} × ${m.size.height} · ${esc(m.author.replace(/\.$/, ""))}</span>
      </a>`).join("");
}

// ---------------------------------------------------------------- pages

// The landing page and anything else hand-written in src/pages/.
for (const file of await readdir(join(ROOT, "src/pages"))) {
  if (extname(file) !== ".html") continue;
  const src = await readFile(join(ROOT, "src/pages", file), "utf8");
  // Front matter: <!-- title: ... --> and <!-- description: ... --> lines.
  const meta = Object.fromEntries([...src.matchAll(/^<!--\s*(\w+):\s*(.*?)\s*-->$/gm)].map((m) => [m[1], m[2]]));
  // rules.html is served as /rules/; index.html and 404.html stay where they are.
  const path = ["index.html", "404.html"].includes(file) ? file : `${file.replace(/\.html$/, "")}/index.html`;
  page(path, { title: meta.title || site.name, description: meta.description || "", body: src });
}

// The changelog: one page for the CHANGELOG, one per release, one index of both.
function changelogNav(current) {
  const link = (href, label, here, extra = "") =>
    `<a class="col-nav-link" href="${href}"${here ? ' aria-current="page"' : ""}>${label}${extra}</a>`;
  return `<nav class="col-nav" aria-label="Changelog">
      <div class="col-nav-group">
        <p class="col-nav-title">Changelog</p>
        ${link("{{root}}changelog/", "What OpenCol changes", current === "all")}
      </div>
      <div class="col-nav-group">
        <p class="col-nav-title">Releases</p>
        ${releases.map((r, i) => link(`{{root}}changelog/${r.version}/`,
          `<span class="col-mono">${r.version}</span>`, current === r.version,
          i === 0 ? ' <span class="col-badge col-badge--line">latest</span>' : "")).join("\n        ")}
      </div>
    </nav>`;
}

function toc(headings) {
  if (!headings.length) return "";
  return `<nav class="col-toc" aria-label="On this page">
      <p class="col-toc-title">On this page</p>
      <ul class="col-toc-list">${headings.map((h) => `
        <li><a class="col-toc-link${h.depth === 3 ? " col-toc-link--sub" : ""}" href="#${h.id}">${esc(h.html)}</a></li>`).join("")}
      </ul>
    </nav>`;
}

function docsPage({ crumbs, current, header, html, headings, pager = "" }) {
  // Braces in fetched Markdown must not read as template values.
  const safe = html.replace(/\{\{/g, "&#123;&#123;");
  return `<div class="col-docs">
  <aside class="col-docs-side" id="docs-side">
    ${changelogNav(current)}
  </aside>
  <main class="col-docs-main" id="main">
    <button class="col-btn col-btn--ghost col-btn--sm col-docs-toggle" type="button"
      aria-controls="docs-side" aria-expanded="false">All releases</button>
    <ol class="col-crumbs">${crumbs}</ol>
    ${header}
    <div class="col-prose">
${safe}
    </div>
    ${pager}
  </main>
  <aside class="col-docs-toc">
    ${toc(headings)}
  </aside>
</div>`;
}

{
  // The CHANGELOG starts with its own "# What OpenCol changes" - the page
  // header says that, so the Markdown's h1 is dropped.
  const { html, headings } = markdown(changelog.replace(/^# .*\n/, ""), { tag: latest.tag, root: "../" });
  page("changelog/index.html", {
    title: `What OpenCol changes — ${site.name}`,
    description: "Everything OpenCol does differently from the 1995 game, by part of the game and release by release.",
    body: docsPage({
      current: "all",
      crumbs: `<li><a href="{{root}}">OpenCol</a></li><li>Changelog</li>`,
      header: `<p class="col-eyebrow">Changelog · as of ${latest.version}</p>
    <h1>What OpenCol changes</h1>`,
      html,
      headings,
    }),
  });
}

releases.forEach((r, i) => {
  const { html, headings } = markdown(r.body, { tag: r.tag, root: "../../" });
  const newer = releases[i - 1], older = releases[i + 1];
  const pager = `<nav class="col-pager" aria-label="Releases">
      ${older ? `<a class="col-pager-link" href="{{root}}changelog/${older.version}/"><span class="col-pager-k">Older</span><span class="col-pager-t">${older.version}</span></a>` : "<span></span>"}
      ${newer ? `<a class="col-pager-link col-pager-link--next" href="{{root}}changelog/${newer.version}/"><span class="col-pager-k">Newer</span><span class="col-pager-t">${newer.version}</span></a>` : ""}
    </nav>`;
  page(`changelog/${r.version}/index.html`, {
    title: `OpenCol ${r.version} — release notes`,
    description: `What came in OpenCol ${r.version}, released ${r.date}.`,
    body: docsPage({
      current: r.version,
      crumbs: `<li><a href="{{root}}">OpenCol</a></li><li><a href="{{root}}changelog/">Changelog</a></li><li>${r.version}</li>`,
      header: `<p class="col-eyebrow">Release · ${longDate(r.date)}</p>
    <h1>OpenCol ${r.version}${i === 0 ? ' <span class="col-badge col-badge--line site-h1-badge">latest</span>' : ""}</h1>
    <div class="col-btnrow site-release-links">
      <a class="col-btn col-btn--outline col-btn--sm" href="${esc(r.url)}">On GitHub</a>
      ${r.assets.filter((a) => a.name.endsWith(".zip")).map((a) =>
        `<a class="col-btn col-btn--ghost col-btn--sm" href="${esc(a.url)}">${esc(a.name.replace(`opencol-${r.version}-`, "").replace(".zip", ""))} <span class="col-meta">${mb(a.size)}</span></a>`).join("\n      ")}
    </div>`,
      html,
      headings,
      pager,
    }),
  });
});

// ---------------------------------------------------------------- write

await rm(OUT, { recursive: true, force: true });
for (const p of pages) {
  const file = join(OUT, p.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, render(p));
}
await cp(join(ROOT, "assets"), join(OUT, "assets"), { recursive: true });
await writeFile(join(OUT, ".nojekyll"), "");
for (const m of mirrored) {
  await mkdir(dirname(join(OUT, m.path)), { recursive: true });
  await writeFile(join(OUT, m.path), m.data);
}
for (const [key, [ref, path]] of media) {
  const file = join(OUT, "media", key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await repoFile(ref, path));
}
console.log(`built ${pages.length} pages, ${media.size} pictures and ${mirrored.length} downloads into _site/: OpenCol ${latest.version}, ${releases.length} releases`);

// ---------------------------------------------------------------- serve

if (args.has("--serve")) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
    ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon" };
  createServer((req, res) => {
    let path = join(OUT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(OUT)) return res.writeHead(403).end();
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) path = join(OUT, "404.html");
    res.writeHead(path.endsWith("404.html") && !req.url.includes("404") ? 404 : 200,
      { "Content-Type": types[extname(path)] || "application/octet-stream" });
    createReadStream(path).pipe(res);
  }).listen(8000, () => console.log("serving _site/ on http://localhost:8000"));
}
