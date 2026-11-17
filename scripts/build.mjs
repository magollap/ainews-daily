// Builds the AI Daily site from the edition files in the repo root.
// - The newest ai-daily-YYYY-MM-DD.html becomes the homepage (/)
// - Every edition is published at /YYYY-MM-DD/ with its PDF alongside
// - /archive/ lists all editions newest-first with their dates and lead headline
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const editions = readdirSync(root)
  .map((f) => f.match(/^ai-daily-(\d{4}-\d{2}-\d{2})\.html$/i) && { file: f, date: RegExp.$1 })
  .filter(Boolean)
  .sort((a, b) => b.date.localeCompare(a.date));

if (!editions.length) throw new Error("No ai-daily-YYYY-MM-DD.html files found");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const longDate = (d) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

const navCss = `<style>
.ad-nav{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;justify-content:space-between;border-bottom:1px solid #16130f;padding:8px 2px;margin:0 0 14px;font:700 11px/1.3 "Liberation Sans",Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase}
.ad-nav a{color:#a3260f;text-decoration:none}.ad-nav a:hover{text-decoration:underline}
.ad-nav .ad-links{display:flex;gap:16px;flex-wrap:wrap}
@media screen{body{max-width:8.5in;margin:0 auto!important;padding:16px 20px 40px!important}}
@media screen and (max-width:700px){body{font-size:11pt!important}.top,[class*="grid"],.cols{display:block!important;column-count:1!important}img{max-width:100%;height:auto}}
@media print{.ad-nav{display:none}}
</style>`;

function nav(ed, isHome) {
  const i = editions.indexOf(ed);
  const newer = editions[i - 1], older = editions[i + 1];
  const pdf = existsSync(join(root, `AI-Daily-${ed.date}.pdf`)) ? `<a href="/${ed.date}/AI-Daily-${ed.date}.pdf">PDF</a>` : "";
  return `<nav class="ad-nav"><span>${isHome ? "Latest edition" : "Edition"} · ${esc(longDate(ed.date))}</span><span class="ad-links">` +
    (newer ? `<a href="/${newer.date}/">← Newer</a>` : "") +
    (older ? `<a href="/${older.date}/">Older →</a>` : "") +
    (isHome ? "" : `<a href="/">Latest</a>`) +
    `<a href="/archive/">Archive</a>${pdf}</span></nav>`;
}

function render(ed, html, isHome) {
  let page = html;
  const head = `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (isHome ? `<link rel="canonical" href="/${ed.date}/">` : "") + navCss;
  page = /<\/head>/i.test(page) ? page.replace(/<\/head>/i, head + "</head>") : head + page;
  page = page.replace(/<body([^>]*)>/i, (m) => m + nav(ed, isHome));
  return page;
}

for (const ed of editions) {
  const html = readFileSync(join(root, ed.file), "utf8");
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  ed.headline = h2 ? strip(h2[1]) : "";
  const dir = join(out, ed.date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), render(ed, html, false));
  const pdf = `AI-Daily-${ed.date}.pdf`;
  if (existsSync(join(root, pdf))) {
    copyFileSync(join(root, pdf), join(dir, pdf));
    ed.pdf = `/${ed.date}/${pdf}`;
  }
  if (ed === editions[0]) writeFileSync(join(out, "index.html"), render(ed, html, true));
}

const items = editions.map((ed, i) => `
  <li>
    <a class="row" href="/${ed.date}/">
      <time datetime="${ed.date}">${esc(longDate(ed.date))}</time>
      ${i === 0 ? '<span class="badge">Latest</span>' : ""}
      <span class="hl">${esc(ed.headline)}</span>
    </a>
    ${ed.pdf ? `<a class="pdf" href="${ed.pdf}">PDF</a>` : ""}
  </li>`).join("");

const archive = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archive — AI Daily</title>
<meta name="description" content="Every past edition of AI Daily, by date.">
<style>
:root{--ink:#16130f;--paper:#fbf8f1;--accent:#a3260f;--mute:#6a6359}
*{box-sizing:border-box}
html,body{background:var(--paper);color:var(--ink);margin:0}
body{font-family:"DejaVu Serif","Liberation Serif",Georgia,serif;max-width:820px;margin:0 auto;padding:28px 20px 60px}
.mast{text-align:center;border-bottom:3px double var(--ink);padding-bottom:10px}
.kicker,.sans{font:700 11px "Liberation Sans",Arial,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(40px,9vw,64px);margin:6px 0 0;line-height:1;letter-spacing:-.02em}
h1 span{color:var(--accent)}
.bar{display:flex;justify-content:space-between;border-bottom:1px solid var(--ink);padding:8px 2px;font:700 11px "Liberation Sans",Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase}
.bar a{color:var(--accent);text-decoration:none}
ul{list-style:none;margin:0;padding:0}
li{display:flex;gap:16px;align-items:baseline;border-bottom:1px solid #d8d0c0;padding:16px 2px}
.row{flex:1;color:inherit;text-decoration:none;display:block}
.row:hover .hl{text-decoration:underline}
time{font:700 12px "Liberation Sans",Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
.badge{font:700 10px "Liberation Sans",Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;background:var(--accent);color:#fff;padding:2px 6px;margin-left:8px;vertical-align:1px}
.hl{display:block;font-size:20px;line-height:1.3;margin-top:4px}
.pdf{font:700 11px "Liberation Sans",Arial,sans-serif;letter-spacing:.12em;color:var(--accent);text-decoration:none;border:1px solid var(--accent);padding:3px 7px;white-space:nowrap}
</style></head>
<body>
<header class="mast"><div class="kicker">The Archive</div><h1>↓: AI <span>Daily</span></h1></header>
<div class="bar"><span>${editions.length} edition${editions.length === 1 ? "" : "s"}</span><a href="/">Read the latest →</a></div>
<ul>${items}
</ul>
</body></html>`;
mkdirSync(join(out, "archive"), { recursive: true });
writeFileSync(join(out, "archive", "index.html"), archive);

// Keep the original repo file names working.
const redirects = editions.flatMap((ed) => [
  `/${ed.file} /${ed.date}/ 301`,
  ...(ed.pdf ? [`/AI-Daily-${ed.date}.pdf ${ed.pdf} 301`] : []),
]);
writeFileSync(join(out, "_redirects"), redirects.join("\n") + "\n");

console.log(`Built ${editions.length} editions; latest is ${editions[0].date}`);
