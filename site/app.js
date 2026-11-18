// AI Daily: theme toggle, search across editions, scroll reveals, copy link.
(() => {
  const root = document.documentElement;

  // Theme
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("ad-theme", root.dataset.theme); } catch (e) {}
  }));

  // Copy link
  document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", async () => {
    try {
      if (navigator.share && matchMedia("(pointer:coarse)").matches) await navigator.share({ title: document.title, url: location.href });
      else { await navigator.clipboard.writeText(location.href); b.textContent = "Link copied"; setTimeout(() => (b.textContent = "Copy link"), 1800); }
    } catch (e) {}
  }));

  // Scroll reveal for cards
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const els = document.querySelectorAll(".card, .ed-card, .arch-list li, .desk-head");
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    els.forEach((el, i) => {
      if (el.getBoundingClientRect().top < innerHeight) return;
      el.classList.add("reveal");
      el.style.transitionDelay = `${(i % 3) * 70}ms`;
      io.observe(el);
    });
  }

  // Search
  const overlay = document.getElementById("search");
  const input = document.getElementById("q");
  const list = document.getElementById("results");
  let index = null, sel = -1, lastFocus = null;
  const escH = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mark = (s, terms) => {
    let h = escH(s);
    for (const t of terms) if (t.length > 1) h = h.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    return h;
  };
  const fmtDate = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  async function load() {
    if (index) return index;
    list.innerHTML = '<li class="search-empty">Loading the wire…</li>';
    try { index = await (await fetch("/search.json")).json(); }
    catch (e) { list.innerHTML = '<li class="search-empty">Search is unavailable right now. Try the archive.</li>'; index = []; }
    return index;
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    sel = -1;
    if (!terms.length) {
      const recent = index.slice(0, 8);
      list.innerHTML = `<li class="search-empty">Type to search ${index.length} stories. Latest:</li>` + recent.map((r) => item(r, [])).join("");
      return;
    }
    const scored = [];
    for (const r of index) {
      const t = r.t.toLowerCase(), hay = `${t} ${r.g} ${r.s} ${r.x} ${r.b}`.toLowerCase();
      if (!terms.every((w) => hay.includes(w))) continue;
      let score = 0;
      for (const w of terms) score += (t.includes(w) ? 6 : 0) + (r.g.toLowerCase().includes(w) ? 3 : 0) + (r.x.toLowerCase().includes(w) ? 2 : 0) + 1;
      scored.push([score, r]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].d.localeCompare(a[1].d));
    list.innerHTML = scored.length ? scored.slice(0, 30).map(([, r]) => item(r, terms)).join("") : `<li class="search-empty">Nothing on the wire for "${escH(q)}".</li>`;
  }
  const item = (r, terms) => `<li><a href="${r.u}"><span class="r-meta">${escH(fmtDate(r.d))} · ${escH(r.s)}</span><span class="r-t">${mark(r.t, terms)}</span><span class="r-x">${mark(r.x, terms)}</span></a></li>`;

  async function open() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    input.focus();
    await load();
    render();
  }
  function close() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    lastFocus && lastFocus.focus && lastFocus.focus();
  }
  document.querySelectorAll("[data-search]").forEach((b) => b.addEventListener("click", open));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  input.addEventListener("input", () => index && render());
  document.addEventListener("keydown", (e) => {
    if (!overlay.hidden) {
      const links = [...list.querySelectorAll("a")];
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(links.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        links.forEach((a, i) => a.setAttribute("aria-selected", i === sel));
        links[sel] && links[sel].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && links[sel]) { e.preventDefault(); location.href = links[sel].href; }
      return;
    }
    const typing = /input|textarea|select/i.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (!typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"))) { e.preventDefault(); open(); }
  });
})();
