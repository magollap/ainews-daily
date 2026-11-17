// Builds the AI Daily news website from the edition files in the repo root.
//
// Every ai-daily-YYYY-MM-DD.html file is parsed into structured content
// (lead story, "60 seconds" briefs, sections, stories, sources) and rendered as:
//   /                      front page of the newest edition
//   /YYYY-MM-DD/           front page of that edition (+ its PDF)
//   /YYYY-MM-DD/<story>/   a page per story
//   /topics/<section>/     every story from a section, across editions
//   /archive/              all editions, newest first, with search
//   /search.json           index used by the on-site search
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsSrc = join(root, "site");
const out = process.env.OUT_DIR || join(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---------- helpers ----------
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s = "") => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const text = (html = "") => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const slugify = (s, max = 72) => {
  let slug = text(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > max) slug = slug.slice(0, max).replace(/-[^-]*$/, "");
  return slug || "story";
};
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…");
const readMins = (html) => Math.max(1, Math.round(text(html).split(" ").length / 230));
const dateObj = (d) => new Date(d + "T12:00:00Z");
const fmt = (d, o) => dateObj(d).toLocaleDateString("en-US", { timeZone: "UTC", ...o });
const longDate = (d) => fmt(d, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const shortDate = (d) => fmt(d, { month: "short", day: "numeric" });
const pad = (n) => String(n).padStart(2, "0");

// Topic names drift slightly between editions ("LLM & Model Updates" vs "LLM &amp; Model Updates"),
// so topics are keyed on a normalized slug.
const topicSlug = (title) => slugify(title.replace(/&/g, " "));

// ---------- parse an edition ----------
function parseEdition(file, date) {
  const doc = parse(readFileSync(join(root, file), "utf8"), { comment: false });

  const editionSpans = doc.querySelectorAll(".edition span").map((s) => text(s.innerHTML));
  const windowLine = editionSpans.find((s) => /window/i.test(s)) || "";
  const kicker = text(doc.querySelector(".mast .kicker")?.innerHTML || "All the AI news that fits the last 24 hours");

  // Lead story + 60-second briefs
  const top = doc.querySelector(".top");
  const box = top?.querySelector(".box");
  const briefs = box ? box.querySelectorAll("li").map((li) => li.innerHTML.trim()) : [];
  box?.remove();
  let lead = null;
  if (top) {
    const label = top.querySelector(".label");
    const h2 = top.querySelector("h2");
    const labelText = text(label?.innerHTML || "Top Story");
    const headline = h2 ? h2.innerHTML.trim() : "";
    label?.remove();
    h2?.remove();
    const dek = top.querySelector(".dek");
    const dekText = dek ? text(dek.innerHTML) : "";
    dek?.remove();
    lead = {
      tag: labelText,
      section: "Top Story",
      topic: "top-story",
      headline,
      dek: dekText,
      body: top.innerHTML.trim().replace(/\uFF0B/g, "+").replace(/\uFF0D/g, "−"),
      lead: true,
    };
  }

  // Sections and their stories
  const sections = [];
  let sources = "";
  for (const sec of doc.querySelectorAll("section")) {
    const h2 = sec.querySelector("h2");
    if (!h2) continue;
    const small = h2.querySelector("small");
    const sub = small ? text(small.innerHTML) : "";
    small?.remove();
    const rawTitle = text(h2.innerHTML);
    h2.remove();
    const m = rawTitle.match(/^(\d+)\s*[·.:-]\s*(.+)$/);
    const num = m ? Number(m[1]) : sections.length + 1;
    const title = m ? m[2].trim() : rawTitle;

    if (/^sources/i.test(title)) {
      sources = sec.innerHTML.replace(
        /<div>\s*((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/[^\s<]*)?)([^<]*)<\/div>/g,
        (_, url, rest) => `<div><a href="${esc(/^https?:/.test(url) ? url : "https://" + url)}" rel="nofollow noopener" target="_blank">${esc(url.replace(/^https?:\/\/(www\.)?/, ""))}</a>${rest}</div>`
      );
      continue;
    }

    const stories = sec.querySelectorAll("article").map((a) => {
      const tagEl = a.querySelector(".tag");
      const h3 = a.querySelector("h3");
      const tag = text(tagEl?.innerHTML || "");
      const headline = h3 ? h3.innerHTML.trim() : "Untitled";
      tagEl?.remove();
      h3?.remove();
      return { tag, headline, body: a.innerHTML.trim().replace(/\uFF0B/g, "+").replace(/\uFF0D/g, "−"), brief: a.classList.contains("brief") };
    });
    sec.querySelectorAll("article").forEach((a) => a.remove());
    // Whatever remains (trending tables, "quiet day" notes, roundups) is section-level material.
    const extras = text(sec.innerHTML) ? sec.innerHTML.trim() : "";
    const quiet = sec.querySelectorAll(".quiet").map((q) => text(q.innerHTML));

    sections.push({ num, title, sub, topic: topicSlug(title), stories, extras, quiet });
  }

  // Slugs, excerpts and reading time for every story
  const used = new Set(["archive", "topics"]);
  const all = [];
  const finish = (s, section) => {
    let slug = slugify(s.headline);
    for (let i = 2; used.has(slug); i++) slug = `${slugify(s.headline)}-${i}`;
    used.add(slug);
    const firstP = parse(s.body).querySelector("p");
    s.slug = slug;
    s.url = `/${date}/${slug}/`;
    const paras = parse(s.body).querySelectorAll("p").map((p) => text(p.innerHTML)).filter((t) => t.length > 40);
    s.excerpt = clip(s.dek || text(firstP ? firstP.innerHTML : s.body), 260);
    s.longExcerpt = clip(s.dek || paras.slice(0, 2).join(" ") || s.excerpt, 520);
    s.mins = readMins(s.body);
    s.section = s.section || section.title;
    s.topic = s.topic || section.topic;
    s.date = date;
    all.push(s);
  };
  if (lead) finish(lead, { title: "Top Story", topic: "top-story" });
  for (const sec of sections) for (const s of sec.stories) finish(s, sec);
  all.forEach((s, i) => { s.prev = all[i - 1]; s.next = all[i + 1]; });

  const hasPdf = existsSync(join(root, `AI-Daily-${date}.pdf`));
  return { file, date, kicker, windowLine, briefs, lead, sections, sources, stories: all, pdf: hasPdf ? `/${date}/AI-Daily-${date}.pdf` : "" };
}

const editions = readdirSync(root)
  .map((f) => { const m = f.match(/^ai-daily-(\d{4}-\d{2}-\d{2})\.html$/i); return m && { file: f, date: m[1] }; })
  .filter(Boolean)
  .sort((a, b) => b.date.localeCompare(a.date))
  .map(({ file, date }) => parseEdition(file, date));

if (!editions.length) throw new Error("No ai-daily-YYYY-MM-DD.html files found");
editions.forEach((ed, i) => { ed.no = editions.length - i; ed.newer = editions[i - 1]; ed.older = editions[i + 1]; });
const latest = editions[0];

// Topics across all editions, named and ordered as in the newest edition that has them
const topics = new Map();
for (const ed of [...editions].reverse()) for (const sec of ed.sections) {
  const t = topics.get(sec.topic) || { slug: sec.topic, title: sec.title, sub: sec.sub, num: sec.num, stories: [] };
  Object.assign(t, { title: sec.title, sub: sec.sub || t.sub, num: sec.num });
  topics.set(sec.topic, t);
}
for (const ed of editions) for (const sec of ed.sections) topics.get(sec.topic).stories.push(...sec.stories);
const topicList = [...topics.values()].sort((a, b) => a.num - b.num);

// ---------- templates ----------
const ICON = {
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16"/></svg>`,
};

function layout({ title, description, body, canonical, bodyClass = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#f6f1e6">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..700&family=Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..600&family=JetBrains+Mono:wght@400;600;700&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<script>try{var t=localStorage.getItem("ad-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
${body}
<div class="search" id="search" hidden>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search stories">
    <div class="search-bar">${ICON.search}<input id="q" type="search" placeholder="Search every edition…" autocomplete="off" aria-label="Search stories"><kbd>esc</kbd></div>
    <ol class="search-results" id="results"></ol>
  </div>
</div>
<script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function utilBar(ed) {
  return `<div class="util">
  <div class="wrap util-in">
    <span class="util-date"><span class="dot" aria-hidden="true"></span>${esc(longDate(ed.date))}</span>
    ${ed.windowLine ? `<span class="util-window">${esc(ed.windowLine.replace(/^window:\s*/i, "Window · "))}</span>` : ""}
    <span class="util-actions">
      <a href="/archive/">Archive</a>
      ${ed.pdf ? `<a href="${ed.pdf}">${ICON.pdf}PDF</a>` : ""}
      <button type="button" class="icon-btn" data-search aria-label="Search">${ICON.search}<span>Search</span></button>
      <button type="button" class="icon-btn" data-theme-toggle aria-label="Toggle dark mode">${ICON.moon}</button>
    </span>
  </div>
</div>`;
}

function masthead(ed, small = false) {
  return `<header class="mast${small ? " mast-sm" : ""}">
  <div class="wrap">
    ${small ? "" : `<p class="mast-kicker">${esc(ed.kicker)}</p>`}
    <a class="brand" href="/"><span class="brand-arrow">↓:</span> AI <em>Daily</em></a>
    ${small ? "" : `<div class="mast-rule"><span>No. ${pad(ed.no)}</span><span>LLMs · Agents · DevOps · Kubernetes · Voice · Video</span><span>${esc(fmt(ed.date, { month: "long", day: "numeric", year: "numeric" }))}</span></div>`}
  </div>
</header>`;
}

function ticker(ed) {
  if (!ed.briefs.length) return "";
  const items = ed.briefs.map((b) => `<li>${b}</li>`).join("");
  return `<div class="ticker" aria-label="Today in 60 seconds">
  <span class="ticker-label">Live wire</span>
  <div class="ticker-track"><ul>${items}</ul><ul aria-hidden="true">${items}</ul></div>
</div>`;
}

function secNav(ed, current = "") {
  const links = ed.sections.filter((s) => s.stories.length || s.extras)
    .map((s) => `<a href="${current ? `/${ed.date}/` : ""}#${s.topic}"${current === s.topic ? ' aria-current="true"' : ""}><span>${pad(s.num)}</span>${esc(s.title)}</a>`).join("");
  return `<nav class="secnav" aria-label="Sections"><div class="wrap secnav-in">${links}</div></nav>`;
}

const card = (s, cls = "") => `<article class="card ${cls}">
  <p class="card-tag">${esc(s.tag || s.section)}</p>
  <h3><a href="${s.url}">${s.headline}</a></h3>
  <p class="card-ex">${esc(cls.includes("feature") ? s.longExcerpt : s.excerpt)}</p>
  <p class="card-meta">${s.mins} min read${s.brief ? " · Briefs" : ""}</p>
</article>`;

function footer() {
  return `<footer class="foot">
  <div class="wrap foot-in">
    <a class="brand brand-foot" href="/"><span class="brand-arrow">↓:</span> AI <em>Daily</em></a>
    <p>The whole AI world at a glance: LLMs, agents, tools, money, DevOps and Kubernetes, voice and video. One edition a day covering the last 24 hours.</p>
    <nav><a href="/">Latest</a><a href="/archive/">Archive</a>${topicList.slice(0, 4).map((t) => `<a href="/topics/${t.slug}/">${esc(t.title)}</a>`).join("")}</nav>
  </div>
</footer>`;
}

function editionPage(ed, isHome) {
  const L = ed.lead;
  // Headlines from the first few desks, shown under the lead so the front page reads like a front page.
  const alsoTop = ed.sections.filter((s) => s.stories.length).slice(0, 4).map((s) => s.stories[0]);
  const leadHtml = L ? `<section class="wrap" aria-label="Top story"><div class="lead">
    <article class="lead-story">
      <p class="eyebrow"><span class="pill">Top story</span>${esc(L.tag.replace(/^top story\s*·?\s*/i, ""))}</p>
      <h2><a href="${L.url}">${L.headline}</a></h2>
      <p class="lead-dek">${esc(L.excerpt)}</p>
      <p class="lead-meta"><a class="btn" href="${L.url}">Read the full story <span aria-hidden="true">→</span></a><span>${L.mins} min read</span></p>
      ${alsoTop.length ? `<div class="also"><p class="also-label">Also leading today</p><ol>${alsoTop.map((s) => `<li><a href="${s.url}"><small>${esc(s.section)}</small><span>${s.headline}</span></a></li>`).join("")}</ol></div>` : ""}
    </article>
    ${ed.briefs.length ? `<aside class="sixty">
      <p class="sixty-label">Today in 60 seconds</p>
      <h3>The short version</h3>
      <ol>${ed.briefs.map((b) => `<li>${b}</li>`).join("")}</ol>
    </aside>` : ""}
  </div></section>` : "";

  const desks = ed.sections.filter((s) => s.stories.length || s.extras).map((sec) => {
    const [first, ...rest] = sec.stories;
    const quietOnly = !sec.stories.length;
    return `<section class="desk wrap" id="${sec.topic}">
    <header class="desk-head">
      <span class="desk-num">${pad(sec.num)}</span>
      <div><h2>${esc(sec.title)}</h2>${sec.sub ? `<p>${esc(sec.sub)}</p>` : ""}</div>
      <a class="desk-more" href="/topics/${sec.topic}/">All ${esc(sec.title)} <span aria-hidden="true">→</span></a>
    </header>
    ${quietOnly ? "" : `<div class="cards">${first ? card(first, rest.length ? `card-feature${rest.length >= 2 ? " card-tall" : ""}` : "card-solo") : ""}${rest.map((s, i) => card(s, i === rest.length - 1 && rest.length > 2 && (rest.length - 2) % 3 === 1 ? "card-wide" : "")).join("")}</div>`}
    ${sec.extras ? `<details class="extras"${quietOnly ? " open" : ""}><summary>${quietOnly ? "Desk notes" : "More from this desk"}</summary><div class="prose">${sec.extras}</div></details>` : ""}
  </section>`;
  }).join("");

  const sources = ed.sources ? `<section class="wrap sources-wrap"><details class="extras sources"><summary>Sources &amp; method</summary><div class="prose">${ed.sources}</div></details></section>` : "";

  const others = editions.filter((e) => e !== ed).slice(0, 4);
  const earlier = others.length ? `<section class="wrap more-eds">
    <header class="desk-head"><span class="desk-num">↓:</span><div><h2>${isHome ? "Earlier editions" : "Other editions"}</h2></div><a class="desk-more" href="/archive/">Full archive <span aria-hidden="true">→</span></a></header>
    <div class="ed-strip">${others.map((e) => `<a class="ed-card" href="/${e.date}/"><time datetime="${e.date}">${esc(fmt(e.date, { weekday: "short", month: "short", day: "numeric" }))}</time><span>${e.lead ? e.lead.headline : ""}</span><small>${e.stories.length} stories</small></a>`).join("")}</div>
  </section>` : "";

  const pager = `<nav class="wrap ed-pager" aria-label="Editions">
    ${ed.newer ? `<a href="/${ed.newer.date}/">← Newer · ${esc(shortDate(ed.newer.date))}</a>` : "<span></span>"}
    ${ed.older ? `<a href="/${ed.older.date}/">Older · ${esc(shortDate(ed.older.date))} →</a>` : "<span></span>"}
  </nav>`;

  const body = `${utilBar(ed)}${masthead(ed)}${ticker(ed)}${secNav(ed)}
<main id="main">
  ${leadHtml}
  ${desks}
  ${sources}
  ${isHome ? "" : pager}
  ${earlier}
</main>
${footer()}`;
  const title = isHome ? `AI Daily: ${text(L?.headline || "")}` : `AI Daily, ${longDate(ed.date)}`;
  return layout({ title, description: L ? L.excerpt : ed.kicker, body, canonical: `/${ed.date}/`, bodyClass: "front" });
}

function storyPage(ed, s) {
  const sec = ed.sections.find((x) => x.topic === s.topic);
  const siblings = (sec ? sec.stories : ed.sections.flatMap((x) => x.stories).slice(0, 5)).filter((x) => x !== s);
  const body = `${utilBar(ed)}${masthead(ed, true)}${secNav(ed, s.topic)}
<main id="main" class="wrap story-wrap">
  <article class="story">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/${ed.date}/">${esc(longDate(ed.date))}</a><span>/</span>${s.lead ? "<span>Top story</span>" : `<a href="/topics/${s.topic}/">${esc(s.section)}</a>`}</nav>
    ${s.tag ? `<p class="story-tag">${esc(s.tag)}</p>` : ""}
    <h1>${s.headline}</h1>
    ${s.dek ? `<p class="story-dek">${esc(s.dek)}</p>` : ""}
    <p class="story-meta"><span>${s.mins} min read</span><span>Edition No. ${pad(ed.no)}</span>${ed.pdf ? `<a href="${ed.pdf}">${ICON.pdf}Print edition (PDF)</a>` : ""}<button type="button" class="linkish" data-share>Copy link</button></p>
    <div class="prose story-body${s.lead ? " is-lead" : ""}">${s.body}</div>
    <nav class="story-pager" aria-label="Stories">
      ${s.prev ? `<a href="${s.prev.url}"><small>← Previous</small>${s.prev.headline}</a>` : "<span></span>"}
      ${s.next ? `<a class="next" href="${s.next.url}"><small>Next →</small>${s.next.headline}</a>` : `<a class="next" href="/${ed.date}/"><small>Done →</small>Back to the front page</a>`}
    </nav>
  </article>
  <aside class="rail">
    ${siblings.length ? `<div class="rail-block"><p class="rail-label">More in ${esc(s.lead ? "today's edition" : s.section)}</p><ol class="rail-list">${siblings.slice(0, 6).map((x) => `<li><a href="${x.url}">${x.headline}</a><small>${esc(x.tag)}</small></li>`).join("")}</ol></div>` : ""}
    ${ed.briefs.length ? `<div class="sixty sixty-rail"><p class="sixty-label">Today in 60 seconds</p><ol>${ed.briefs.map((b) => `<li>${b}</li>`).join("")}</ol></div>` : ""}
  </aside>
</main>
${footer()}`;
  return layout({ title: `${text(s.headline)} | AI Daily`, description: s.excerpt, body, canonical: s.url, bodyClass: "story-page" });
}

function topicPage(t) {
  const byDate = editions.map((ed) => ({ ed, stories: t.stories.filter((s) => s.date === ed.date) })).filter((g) => g.stories.length);
  const body = `${utilBar(latest)}${masthead(latest, true)}
<main id="main" class="wrap">
  <header class="page-head"><p class="eyebrow"><span class="pill">Desk</span>${t.stories.length} stories across ${byDate.length} edition${byDate.length === 1 ? "" : "s"}</p><h1>${esc(t.title)}</h1>${t.sub ? `<p>${esc(t.sub)}</p>` : ""}
    <nav class="topic-chips">${topicList.map((x) => `<a href="/topics/${x.slug}/"${x === t ? ' aria-current="true"' : ""}>${esc(x.title)}</a>`).join("")}</nav>
  </header>
  ${byDate.map((g) => `<section class="desk"><header class="desk-head"><span class="desk-num">${esc(fmt(g.ed.date, { day: "2-digit" }))}</span><div><h2>${esc(longDate(g.ed.date))}</h2></div><a class="desk-more" href="/${g.ed.date}/#${t.slug}">In the edition <span aria-hidden="true">→</span></a></header><div class="cards">${g.stories.map((s) => card(s)).join("")}</div></section>`).join("")}
</main>
${footer()}`;
  return layout({ title: `${t.title} | AI Daily`, description: `Every ${t.title} story from AI Daily.`, body, canonical: `/topics/${t.slug}/`, bodyClass: "topic-page" });
}

function archivePage() {
  const totalStories = editions.reduce((n, e) => n + e.stories.length, 0);
  const months = new Map();
  for (const ed of editions) {
    const k = fmt(ed.date, { month: "long", year: "numeric" });
    months.set(k, [...(months.get(k) || []), ed]);
  }
  const body = `${utilBar(latest)}${masthead(latest, true)}
<main id="main" class="wrap">
  <header class="page-head"><p class="eyebrow"><span class="pill">Archive</span>${editions.length} editions · ${totalStories} stories</p><h1>Every edition</h1><p>Each one covers the last 24 hours. Pick a day, a desk, or <button type="button" class="linkish" data-search>search all of it</button>.</p>
    <nav class="topic-chips">${topicList.map((t) => `<a href="/topics/${t.slug}/">${esc(t.title)} <small>${t.stories.length}</small></a>`).join("")}</nav>
  </header>
  ${[...months].map(([m, eds]) => `<section class="arch-month"><h2>${esc(m)}</h2><ol class="arch-list">${eds.map((ed) => `<li>
    <a class="arch-row" href="/${ed.date}/">
      <span class="arch-day"><b>${esc(fmt(ed.date, { day: "2-digit" }))}</b>${esc(fmt(ed.date, { weekday: "short" }))}</span>
      <span class="arch-main">${ed === latest ? '<span class="pill">Latest</span>' : ""}<span class="arch-hl">${ed.lead ? ed.lead.headline : ""}</span><span class="arch-sub">${ed.stories.length} stories · ${ed.sections.filter((s) => s.stories.length).map((s) => esc(s.title)).join(" · ")}</span></span>
    </a>
    ${ed.pdf ? `<a class="arch-pdf" href="${ed.pdf}">${ICON.pdf}PDF</a>` : ""}
  </li>`).join("")}</ol></section>`).join("")}
</main>
${footer()}`;
  return layout({ title: "Archive | AI Daily", description: "Every past edition of AI Daily, by date.", body, canonical: "/archive/", bodyClass: "archive-page" });
}

// ---------- write ----------
const write = (path, html) => { mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), html); };

for (const ed of editions) {
  write(`${ed.date}/index.html`, editionPage(ed, false));
  if (ed.pdf) copyFileSync(join(root, `AI-Daily-${ed.date}.pdf`), join(out, ed.date, `AI-Daily-${ed.date}.pdf`));
  for (const s of ed.stories) write(`${ed.date}/${s.slug}/index.html`, storyPage(ed, s));
}
write("index.html", editionPage(latest, true));
write("archive/index.html", archivePage());
for (const t of topicList) write(`topics/${t.slug}/index.html`, topicPage(t));
write("topics/index.html", `<!doctype html><meta http-equiv="refresh" content="0;url=/archive/">`);

mkdirSync(join(out, "assets"), { recursive: true });
for (const f of readdirSync(assetsSrc)) copyFileSync(join(assetsSrc, f), join(out, "assets", f));

write("search.json", JSON.stringify(editions.flatMap((ed) => ed.stories.map((s) => ({
  t: text(s.headline), x: s.excerpt, g: s.tag, s: s.section, d: s.date, u: s.url, b: clip(text(s.body), 1200),
})))));

write("404.html", layout({
  title: "Not found | AI Daily", description: "Page not found", bodyClass: "nf",
  body: `${utilBar(latest)}${masthead(latest, true)}<main id="main" class="wrap page-head nf-main"><p class="eyebrow"><span class="pill">404</span>Off the wire</p><h1>That story isn't in any edition.</h1><p>Try the <a href="/">latest edition</a>, the <a href="/archive/">archive</a>, or <button type="button" class="linkish" data-search>search</button>.</p></main>${footer()}`,
}));

// Keep the original repo file names working.
const redirects = editions.flatMap((ed) => [
  `/${ed.file} /${ed.date}/ 301`,
  ...(ed.pdf ? [`/AI-Daily-${ed.date}.pdf ${ed.pdf} 301`] : []),
]);
write("_redirects", redirects.join("\n") + "\n");

console.log(`Built ${editions.length} editions, ${editions.reduce((n, e) => n + e.stories.length, 0)} stories, ${topicList.length} topics; latest is ${latest.date}`);
