/**
 * Site-family extractors (page context).
 * Prefer structured data / semantic tags / multi-selector fallbacks over a single class name.
 * Inject before content/extract-page.js.
 */
(function () {
  "use strict";

  const MIN_OK = 80;
  const MAX_PAGES = 12;
  const NEXT_LABELS = [
    "次の話",
    "次話",
    "次のエピソード",
    "次へ",
    "次ページ",
    "次のページ",
    "次頁",
    "つづき",
    "続きを読む",
    "次を読む",
  ];
  const PAGE_NEXT_LABELS = ["次のページ", "次ページ", "次頁", "次へ", "続きを読む", "つづき"];
  const PAYWALL_TEXT =
    /有料会員|会員限定|有料記事|本誌購読|プレミアム会員|続きを読むには|全文を読むには|ログインして続き|登録すると続き|購読すると|この記事は有料|Paywall|subscriber[- ]only|members?[- ]only/i;
  const PAYWALL_SELS = [
    '[class*="paywall" i]',
    '[id*="paywall" i]',
    "[data-paywall]",
    ".paid-member",
    ".member-only",
    ".c-paywall",
    ".article-paywall",
    ".regist-continue",
    ".ynPaywall",
    ".ymuiPayWall",
  ].join(",");

  function hostOf(url) {
    try {
      return new URL(url || location.href).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function hostMatches(url, hosts) {
    const h = hostOf(url);
    return (hosts || []).some((raw) => {
      const x = String(raw).replace(/^www\./i, "").toLowerCase();
      return h === x || h.endsWith("." + x);
    });
  }

  function absUrl(href, base) {
    if (!href) return null;
    try {
      const u = new URL(href, base || location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.href;
    } catch {
      return null;
    }
  }

  function firstEl(root, selectors) {
    const doc = root || document;
    for (const sel of selectors || []) {
      if (!sel) continue;
      try {
        const el = doc.querySelector(sel);
        if (el) return el;
      } catch (_) {
        /* ignore */
      }
    }
    return null;
  }

  function firstEls(root, selectors) {
    const doc = root || document;
    for (const sel of selectors || []) {
      if (!sel) continue;
      try {
        const list = [...doc.querySelectorAll(sel)];
        if (list.length) return uniqueTopNodes(list);
      } catch (_) {
        /* ignore */
      }
    }
    return [];
  }

  function uniqueTopNodes(nodes) {
    const arr = [...nodes];
    return arr.filter((n) => !arr.some((o) => o !== n && o.contains(n)));
  }

  function removeAll(root, selectors) {
    for (const sel of selectors || []) {
      try {
        root.querySelectorAll(sel).forEach((n) => n.remove());
      } catch (_) {
        /* ignore */
      }
    }
  }

  function applyRuby(root, rubyMode) {
    if (rubyMode !== "reading") {
      root.querySelectorAll("rt, rp").forEach((n) => n.remove());
      return;
    }
    root.querySelectorAll("ruby").forEach((ruby) => {
      const rts = [...ruby.querySelectorAll("rt")].map((r) => r.textContent).join("");
      ruby.replaceWith(document.createTextNode(rts || ruby.textContent || ""));
    });
  }

  /** Keep in sync with chrome-extension/lib/sanitizeSpeech.js */
  function hasSpeakable(text) {
    return /[\p{L}\p{N}]/u.test(String(text || ""));
  }

  function stripSpeech(text) {
    const DECOR = "[-–—―─━=_＊*☆★●○◆◇■□▪▫※~～♡♥♪♫#＃▲▼△▽]";
    let t = String(text || "")
      .replace(/^\uFEFF/, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060]/g, "")
      .replace(/https?:\/\/[^\s]+/gi, " ")
      .replace(/\bwww\.[^\s]+/gi, " ")
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
      .replace(/\[\d+\]/g, "")
      .replace(/※\s*\d+/g, "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/［(?:挿絵|画像|図)］|【(?:挿絵|画像|図)】|\[(?:挿絵|画像|図|image|img|pic)\]/gi, " ")
      .replace(/［(?:広告|ＡＤ|AD|PR|ＰＲ)］|【(?:広告|ＡＤ|AD|PR|ＰＲ)】|\[(?:PR|AD|広告)\]/gi, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/-{3,}/g, " ")
      .replace(/={3,}/g, " ")
      .replace(/~{3,}/g, " ")
      .replace(/～{3,}/g, " ")
      .replace(/\*{3,}/g, " ")
      .replace(/＊{3,}/g, " ")
      .replace(/_{3,}/g, " ")
      .replace(/[─━]{3,}/g, " ")
      .replace(/[―—]{3,}/g, " ")
      .replace(/[☆★●○◆◇■□▪▫※♡♥♪♫]{3,}/g, " ")
      .replace(/^#{1,6}[ \t]+/gm, "")
      .replace(/^>[ \t]+/gm, "")
      .replace(/^`{3,}[^\n]*$/gm, "")
      .replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*$/gm, "");

    t = t.replace(new RegExp(`(?:^|\\n)[ \\t]*(?:${DECOR}[ \\t]*){2,}(?=\\n|$)`, "g"), "\n");
    t = t.replace(
      /([。．！？!?）」』】］])[ \t]*[-–─━=_＊*☆★●○◆◇■□▪▫※~～♡♥♪♫#＃▲▼△▽]{2,}[ \t]*/g,
      "$1",
    );
    t = t.replace(new RegExp(`([。．！？!?）」』】］])[ \\t]*(?:${DECOR}[ \\t]*){3,}`, "g"), "$1");

    t = t
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && hasSpeakable(line))
      .join("\n");

    return t
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function speechFrom(el, opts) {
    opts = opts || {};
    if (!el) return "";
    if (typeof el === "string") {
      const html = el.trim();
      if (!html) return "";
      if (!/<[a-z][\s\S]*>/i.test(html)) return stripSpeech(html);
      const div = document.createElement("div");
      div.innerHTML = html;
      return speechFrom(div, opts);
    }
    const clone = el.cloneNode(true);
    removeAll(clone, opts.exclude || []);
    clone.querySelectorAll("pre, code, script, style, noscript, svg, iframe, canvas, form, button, nav, aside").forEach((n) => n.remove());
    clone.querySelectorAll("sup").forEach((n) => n.remove());
    if (opts.mathMode !== "read") {
      clone.querySelectorAll(".MathJax, .katex, math, .ltx_Math").forEach((n) => n.remove());
    }
    applyRuby(clone, opts.rubyMode || "ignore");
    return stripSpeech(clone.innerText || clone.textContent || "");
  }

  function titleFrom(root, selectors, fallback) {
    const el = firstEl(root, selectors);
    const t = el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    return t || fallback || "";
  }

  function jsonLdBlocks(root) {
    const out = [];
    const doc = root || document;
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const data = JSON.parse(s.textContent || "null");
        const arr = Array.isArray(data) ? data : data && data["@graph"] ? data["@graph"] : [data];
        for (const item of arr) if (item && typeof item === "object") out.push(item);
      } catch (_) {
        /* ignore */
      }
    });
    return out;
  }

  function jsonLdArticle(root) {
    const types = /Article|NewsArticle|BlogPosting|ReportageNewsArticle|ScholarlyArticle/i;
    for (const item of jsonLdBlocks(root)) {
      const t = item["@type"];
      const list = Array.isArray(t) ? t : [t];
      if (list.some((x) => types.test(String(x || "")))) return item;
    }
    return null;
  }

  function ldText(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(ldText).filter(Boolean).join("\n");
    if (typeof v === "object") return v["@value"] || v.name || v.headline || "";
    return String(v);
  }

  function parseNextData(root) {
    const el = (root || document).querySelector("script#__NEXT_DATA__");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "null");
    } catch {
      return null;
    }
  }

  function walkJson(obj, fn, depth) {
    if (obj == null || depth > 12) return;
    fn(obj);
    if (Array.isArray(obj)) {
      for (const v of obj) walkJson(v, fn, (depth || 0) + 1);
    } else if (typeof obj === "object") {
      for (const v of Object.values(obj)) walkJson(v, fn, (depth || 0) + 1);
    }
  }

  function longestJsonString(obj, keys) {
    let best = "";
    const keySet = new Set((keys || []).map((k) => k.toLowerCase()));
    walkJson(obj, (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v !== "string" || v.length < best.length) continue;
        if (keySet.size && !keySet.has(k.toLowerCase())) continue;
        best = v;
      }
    });
    return best;
  }

  function detectPaywall(root, extra) {
    const doc = root || document;
    try {
      if (doc.querySelector(PAYWALL_SELS)) return true;
    } catch (_) {
      /* ignore */
    }
    return PAYWALL_TEXT.test(String(extra || ""));
  }

  function linkLabel(a) {
    return ((a.getAttribute("aria-label") || "") + " " + (a.getAttribute("title") || "") + " " + (a.textContent || ""))
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeAuth(href) {
    return /login|signin|signup|register|member|subscribe|purchase|cart|checkout|premium/i.test(href || "");
  }

  function findLinkByLabels(root, labels, baseUrl) {
    const doc = root || document;
    const wanted = (labels || NEXT_LABELS).map((s) => s.toLowerCase());
    let best = null;
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = absUrl(a.getAttribute("href"), baseUrl);
      if (!href || href === absUrl(baseUrl) || looksLikeAuth(href)) continue;
      const label = linkLabel(a).toLowerCase();
      if (!label) continue;
      if (wanted.some((w) => label === w || label.includes(w))) {
        const cls = (a.className || "") + " " + (a.parentElement && a.parentElement.className) || "";
        const score = /next|pager|pagination|nav/i.test(cls) ? 2 : 1;
        if (!best || score > best.score) best = { href, score };
      }
    }
    return best ? best.href : null;
  }

  function relNext(root, baseUrl) {
    const doc = root || document;
    const el = doc.querySelector('link[rel="next"], a[rel="next"]');
    return el ? absUrl(el.getAttribute("href") || el.href, baseUrl) : null;
  }

  function classNext(root, selectors, baseUrl) {
    const prev = /前へ|前の話|前話|prev|back/i;
    const nextHint = /次へ|次の話|次話|次のエピソード|next/i;
    const doc = root || document;
    for (const sel of selectors || []) {
      let list = [];
      try {
        list = [...doc.querySelectorAll(sel)];
      } catch (_) {
        continue;
      }
      for (const a of list) {
        const href = absUrl(a.getAttribute("href") || a.href, baseUrl);
        if (!href || looksLikeAuth(href)) continue;
        const label = linkLabel(a);
        if (prev.test(label) && !nextHint.test(label)) continue;
        if (nextHint.test(label) || /next/i.test(sel + " " + (a.className || ""))) return href;
      }
      if (/next/i.test(sel)) {
        const a = list.find((el) => {
          const href = absUrl(el.getAttribute("href") || el.href, baseUrl);
          const label = linkLabel(el);
          return href && !looksLikeAuth(href) && !(prev.test(label) && !nextHint.test(label));
        });
        if (a) return absUrl(a.getAttribute("href") || a.href, baseUrl);
      }
    }
    return null;
  }

  function findNextEpisode(root, spec, baseUrl) {
    return (
      classNext(root, spec.nextSels, baseUrl) ||
      relNext(root, baseUrl) ||
      findLinkByLabels(root, spec.nextLabels || NEXT_LABELS, baseUrl)
    );
  }

  function sameArticleNext(current, next) {
    let a;
    let b;
    try {
      a = new URL(current);
      b = new URL(next);
    } catch {
      return false;
    }
    if (a.origin !== b.origin) return false;
    if (looksLikeAuth(b.href)) return false;
    const pageKeys = ["page", "p", "pno", "pageNo"];
    const aPage = pageKeys.map((k) => a.searchParams.get(k)).find(Boolean) || "1";
    const bPage = pageKeys.map((k) => b.searchParams.get(k)).find(Boolean);
    if (bPage && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "") && String(bPage) !== String(aPage)) {
      return true;
    }
    const strip = (p) =>
      p
        .replace(/\/+$/, "")
        .replace(/\/(?:page|p)\/\d+$/i, "")
        .replace(/\/\d+$/, "")
        .replace(/-\d+(?:\.html?)?$/i, "");
    return strip(a.pathname) === strip(b.pathname) && a.pathname.replace(/\/+$/, "") !== b.pathname.replace(/\/+$/, "");
  }

  function findPaginationNext(root, currentUrl) {
    const rel = relNext(root, currentUrl);
    if (rel && sameArticleNext(currentUrl, rel)) return rel;
    const labeled = findLinkByLabels(root, PAGE_NEXT_LABELS, currentUrl);
    if (labeled && sameArticleNext(currentUrl, labeled)) return labeled;
    const doc = root || document;
    for (const a of doc.querySelectorAll(
      '.pager a[href], .pagination a[href], .pagenation a[href], nav[class*="pager" i] a[href], [class*="pagination" i] a[href], [class*="page-link" i]',
    )) {
      const href = absUrl(a.getAttribute("href") || a.href, currentUrl);
      if (href && sameArticleNext(currentUrl, href)) return href;
    }
    return null;
  }

  async function fetchDoc(url) {
    try {
      const res = await fetch(url, { credentials: "include", redirect: "follow" });
      if (!res.ok) return null;
      const html = await res.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function collectPages(startDoc, startUrl, extractFn) {
    const seen = new Set([absUrl(startUrl)]);
    const parts = [];
    const first = extractFn(startDoc, startUrl);
    if (first) parts.push(first);
    let doc = startDoc;
    let url = startUrl;
    for (let i = 0; i < MAX_PAGES; i++) {
      const next = findPaginationNext(doc, url);
      if (!next || seen.has(next)) break;
      seen.add(next);
      const nextDoc = await fetchDoc(next);
      if (!nextDoc) break;
      const t = extractFn(nextDoc, next);
      if (!t || t.length < 40) break;
      if (parts.length && t.slice(0, 60) === parts[parts.length - 1].slice(0, 60) && t.length <= parts[parts.length - 1].length * 1.05) {
        break;
      }
      parts.push(t);
      doc = nextDoc;
      url = next;
    }
    return { text: parts.join("\n\n"), pages: parts.length };
  }

  function result(partial) {
    return {
      ok: true,
      confident: partial.confident !== false,
      title: partial.title || "",
      text: partial.text || "",
      nextEpisodeUrl: partial.nextEpisodeUrl || null,
      source: partial.source || "fetcher",
      paywall: !!partial.paywall,
      contentSelector: partial.contentSelector || null,
      pagesFetched: partial.pagesFetched || 1,
      family: partial.family || null,
    };
  }

  function pickArticleNode(root) {
    const doc = root || document;
    const nodes = uniqueTopNodes(
      doc.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]'),
    );
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      const text = (el.innerText || "").trim();
      if (text.length < 80) continue;
      const links = el.querySelectorAll("a").length;
      const ps = el.querySelectorAll("p").length;
      const score = text.length + ps * 80 - links * 40;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /* ---------- ① novels: body + next; selectors differ ---------- */

  const NOVEL_SITES = [
    {
      id: "ncode",
      name: "小説家になろう",
      hosts: ["ncode.syosetu.com", "novelcom.syosetu.com"],
      title: [".p-novel__title", "h1.p-novel__title", ".novel_subtitle", ".novel_title", "h1"],
      content: [
        ".p-novel__body",
        "#novel_honbun",
        ".js-novel-text",
        ".p-novel__text:not(.p-novel__text--preface):not(.p-novel__text--afterword)",
      ],
      exclude: [".c-announce", ".p-novel__notice", ".p-novel__author"],
      nextSels: [
        "a.p-novel__navlink--next",
        "a.c-pager__item--next",
        ".c-pager__item--next a",
        "a.novelview_pager-next",
      ],
    },
    {
      id: "moonlight",
      name: "ムーンライトノベルズ",
      hosts: ["novel18.syosetu.com", "mnlt.syosetu.com", "noc.syosetu.com", "mid.syosetu.com"],
      title: [".p-novel__title", "h1.p-novel__title", ".novel_subtitle", ".novel_title", "h1"],
      content: [
        ".p-novel__body",
        "#novel_honbun",
        ".js-novel-text",
        ".p-novel__text:not(.p-novel__text--preface):not(.p-novel__text--afterword)",
      ],
      exclude: [".c-announce", ".p-novel__notice", ".p-novel__author"],
      nextSels: [
        "a.p-novel__navlink--next",
        "a.c-pager__item--next",
        ".c-pager__item--next a",
        "a.novelview_pager-next",
      ],
    },
    {
      id: "kakuyomu",
      name: "カクヨム",
      hosts: ["kakuyomu.jp"],
      path: /\/works\/[^/]+\/episodes\//,
      title: [
        "p.widget-episodeTitle",
        "h1.widget-episodeTitle",
        ".widget-episodeTitle",
        '[class*="episodeTitle"]',
        "h1",
      ],
      content: [
        ".widget-episodeBody",
        "div.widget-episodeBody",
        "div.widget-episode",
        '[class*="episodeBody"]',
        "article .widget-episode",
      ],
      exclude: [".widget-episodeTitle"],
      nextSels: [
        "a#contentMain-readNextEpisode",
        'a[data-link-click-action-name="EpisodeNext"]',
        'a[rel="next"]',
      ],
      nextLabels: ["次のエピソード", "次へ", "次の話"],
      jsonKeys: ["episodeBody", "bodyHtml", "contentHtml", "body"],
    },
    {
      id: "hameln",
      name: "ハーメルン",
      hosts: ["syosetu.org", "h.syosetu.org"],
      path: /\/novel\//,
      title: ['#maind span[itemprop="name"]', ".episode-list__title", "h1", "title"],
      content: ["#honbun", "#maind > div.ss", "#maind .ss", "#maind"],
      exclude: [".novelnavi", "#maegaki_open", "#atogaki_open", ".episode-list", "div[style*='text-align:right']"],
      nextSels: [".novelnavi a", 'a[rel="next"]'],
      nextLabels: ["次へ", "次の話", "次話"],
    },
    {
      id: "alphapolis",
      name: "アルファポリス",
      hosts: ["alphapolis.co.jp"],
      path: /\/novel\//,
      title: ["h2.episode-title", ".episode-title", "h1", ".title"],
      content: ["#novelBody", "div#novelBody", ".novel-body", "#novel_body", ".episode-body"],
      exclude: [".episode-navigation", ".sns", ".ad"],
      nextSels: [
        ".episode-navigation a.next",
        "a.next-episode",
        ".pager .next a",
        ".episode-pager a.next",
      ],
      nextLabels: ["次の話", "次へ", "次話"],
    },
  ];

  function novelSiteFor(url) {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    return NOVEL_SITES.find((s) => hostMatches(url, s.hosts) && (!s.path || s.path.test(path))) || null;
  }

  async function extractNovel(ctx) {
    const url = ctx.url;
    const site = novelSiteFor(url);
    if (!site) return null;
    const doc = ctx.document;
    const title = titleFrom(doc, site.title, doc.title || "");
    let text = "";
    let contentSelector = site.content[0];

    if (site.id === "kakuyomu") {
      const nextData = parseNextData(doc);
      const raw = nextData ? longestJsonString(nextData, site.jsonKeys) : "";
      const looksBody = raw && raw.length >= 200 && (/<[a-z][\s\S]*>/i.test(raw) || raw.length > 800);
      if (looksBody) text = speechFrom(raw, { rubyMode: "ignore", exclude: site.exclude });
    }

    if (text.length < MIN_OK) {
      const nodes = firstEls(doc, site.content);
      if (nodes.length) {
        contentSelector = site.content.find((sel) => {
          try {
            return doc.querySelector(sel);
          } catch {
            return false;
          }
        });
        text = nodes
          .map((el) => speechFrom(el, { rubyMode: "ignore", exclude: site.exclude }))
          .filter(Boolean)
          .join("\n\n");
      }
    }

    const nextEpisodeUrl = findNextEpisode(doc, site, url);
    const paywall = detectPaywall(doc, text) || (/会員|購入|読むには/.test(text.slice(0, 80)) && text.length < 200);
    const isIndex =
      (site.id === "hameln" && doc.querySelector(".episode-list") && !doc.querySelector("#honbun")) ||
      ((site.id === "ncode" || site.id === "moonlight") &&
        doc.querySelector(".p-eplist, .index_box") &&
        !doc.querySelector(".p-novel__body, #novel_honbun"));
    return result({
      title,
      text,
      nextEpisodeUrl,
      source: "fetcher:novel:" + site.id,
      contentSelector,
      paywall,
      family: "novel",
      confident: !isIndex && text.length >= MIN_OK,
    });
  }

  /* ---------- ② Aozora: ruby readings ---------- */

  function extractAozora(ctx) {
    const doc = ctx.document;
    const body = firstEl(doc, [".main_text", "div.main_text", ".main-text"]);
    if (!body) return null;
    const clone = body.cloneNode(true);
    removeAll(clone, [".bibliographical_information", ".notation_notes", "#contents", "rp"]);
    clone.querySelectorAll("img.gaiji[alt], img[class*='gaiji'][alt]").forEach((img) => {
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt && !alt.startsWith("※") && alt.length <= 8) {
        img.replaceWith(document.createTextNode(alt));
      } else {
        img.remove();
      }
    });
    applyRuby(clone, "reading");
    const text = stripSpeech(clone.innerText || clone.textContent || "");
    return result({
      title: titleFrom(doc, [".title", "h1.title", "h1", "title"], doc.title),
      text,
      source: "fetcher:aozora",
      contentSelector: ".main_text",
      family: "aozora",
      confident: text.length >= MIN_OK,
    });
  }

  /* ---------- Wikipedia ---------- */

  const WIKI_STOP = [
    "脚注",
    "注釈",
    "出典",
    "参考文献",
    "関連文献",
    "関連項目",
    "外部リンク",
    "参考文献一覧",
    "注釈・出典",
    "See also",
    "References",
    "External links",
    "Notes",
    "Bibliography",
    "Further reading",
    "Sources",
    "Citations",
    "Notes and references",
  ];
  const WIKI_EXCLUDE = [
    ".infobox",
    "table.infobox",
    ".navbox",
    ".vertical-navbox",
    ".sidebar",
    ".side-box",
    ".sistersitebox",
    ".sister-box",
    ".hatnote",
    ".ambox",
    ".tmbox",
    ".cmbox",
    ".ombox",
    ".fmbox",
    ".shortdescription",
    ".mw-editsection",
    ".mw-empty-elt",
    "#toc",
    ".toc",
    ".sidebar-toc",
    ".thumb",
    ".gallery",
    ".reflist",
    ".references",
    ".mw-references-wrap",
    "ol.references",
    "sup.reference",
    ".reference",
    ".mw-cite-backlink",
    "#catlinks",
    ".printfooter",
    ".metadata",
    ".noprint",
    ".navbox-styles",
    "table.wikitable",
    ".mw-authority-control",
    ".ext-discussiontools-init-replylink-buttons",
    "style",
    "script",
  ];

  function headingLabel(el) {
    const h = el.matches("h1,h2,h3,h4") ? el : el.querySelector("h1,h2,h3,h4, .mw-headline");
    const raw = ((h || el).textContent || "").replace(/\[.*?\]/g, "");
    return raw.replace(/編集/g, "").replace(/\s+/g, " ").trim();
  }

  function cutWikiTail(root) {
    const stops = new Set(WIKI_STOP.map((s) => s.toLowerCase()));
    const heads = [...root.querySelectorAll("h1, h2, h3, .mw-heading")];
    let cut = null;
    for (const h of heads) {
      const label = headingLabel(h);
      if (stops.has(label.toLowerCase()) || WIKI_STOP.some((s) => label === s || label.startsWith(s + " "))) {
        cut = h.closest(".mw-heading") || h;
        break;
      }
    }
    if (!cut) return;
    let node = cut;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
  }

  async function extractWikipedia(ctx) {
    const doc = ctx.document;
    const url = ctx.url;
    const title = titleFrom(doc, ["#firstHeading", "h1#firstHeading", "h1"], doc.title.replace(/\s*[–—-]\s*Wikipedia.*$/i, ""));
    const root =
      firstEl(doc, ["#mw-content-text > .mw-parser-output", "#mw-content-text .mw-parser-output", ".mw-parser-output"]) ||
      null;
    let text = "";
    if (root) {
      const clone = root.cloneNode(true);
      cutWikiTail(clone);
      text = speechFrom(clone, { rubyMode: "ignore", exclude: WIKI_EXCLUDE });
    }

    if (text.length < 200) {
      try {
        const page =
          (typeof mw !== "undefined" && mw.config && mw.config.get && mw.config.get("wgPageName")) ||
          decodeURIComponent((new URL(url).pathname.split("/wiki/")[1] || "").replace(/_/g, " "));
        if (page) {
          const api =
            `${location.origin}/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain` +
            `&redirects=1&format=json&origin=*&titles=${encodeURIComponent(page)}`;
          const data = await fetchJson(api);
          const pages = data && data.query && data.query.pages;
          const rec = pages && Object.values(pages)[0];
          const extract = rec && rec.extract;
          if (extract && extract.length > text.length) {
            const cut = extract.split(/\n+/);
            const kept = [];
            for (const line of cut) {
              const t = line.replace(/^=+\s*|\s*=+$/g, "").trim();
              if (WIKI_STOP.some((s) => t === s || t.startsWith(s + " "))) break;
              kept.push(line);
            }
            text = stripSpeech(kept.join("\n"));
          }
        }
      } catch (_) {
        /* ignore API errors; DOM text stands */
      }
    }

    return result({
      title,
      text,
      source: "fetcher:wikipedia",
      contentSelector: "#mw-content-text > .mw-parser-output",
      family: "wikipedia",
      confident: text.length >= MIN_OK,
    });
  }

  /* ---------- ③ news: Yahoo / NHK, shared paywall ---------- */

  function newsBodyFromDom(doc, selectors, exclude) {
    const nodes = firstEls(doc, selectors);
    if (!nodes.length) {
      const article = jsonLdArticle(doc);
      const ld = speechFrom(ldText(article && article.articleBody));
      if (ld.length >= MIN_OK) return { text: ld, selector: null };
      const picked = pickArticleNode(doc);
      return {
        text: picked ? speechFrom(picked, { exclude }) : "",
        selector: picked ? "article, main, [itemprop='articleBody']" : null,
      };
    }
    return {
      text: nodes.map((el) => speechFrom(el, { exclude })).filter(Boolean).join("\n\n"),
      selector: selectors[0],
    };
  }

  async function extractYahoo(ctx) {
    const doc = ctx.document;
    const exclude = [
      ".sns",
      ".related",
      ".recommend",
      ".comment",
      ".ynDetailLink",
      ".article_footer",
      '[class*="Related"]',
    ];
    const body = newsBodyFromDom(
      doc,
      [
        ".article_body",
        ".article_body.highLightSearchTarget",
        ".highLightSearchTarget",
        '[itemprop="articleBody"]',
        "article .article_body",
        "article",
      ],
      exclude,
    );
    const article = jsonLdArticle(doc);
    let text = body.text;
    const ld = speechFrom(ldText(article && article.articleBody));
    if (ld.length > text.length * 1.1) text = ld;
    const title = titleFrom(doc, ["h1", ".article_header h1"], ldText(article && (article.headline || article.name)) || doc.title);
    return result({
      title: title.replace(/\s*-\s*Yahoo!.*/i, ""),
      text,
      source: "fetcher:news:yahoo",
      contentSelector: body.selector || ".article_body",
      paywall: detectPaywall(doc, text),
      family: "news",
      confident: text.length >= MIN_OK,
    });
  }

  async function extractNhk(ctx) {
    const doc = ctx.document;
    const url = ctx.url;
    const exclude = [".content--related", ".related", ".c-aside", '[class*="Related"]', "aside"];
    const body = newsBodyFromDom(
      doc,
      [
        "#news_textbody",
        "#news_textmore",
        ".content--detail-more",
        ".content--body",
        ".content--detail-body",
        '[itemprop="articleBody"]',
        "article",
        "main article",
        "main",
      ],
      exclude,
    );
    // Old NHK often splits lead + more.
    const more = firstEl(doc, ["#news_textmore"]);
    let text = body.text;
    if (more && !/#news_textmore/.test(body.selector || "")) {
      const extra = speechFrom(more, { exclude });
      if (extra && !text.includes(extra.slice(0, 40))) text = [text, extra].filter(Boolean).join("\n\n");
    }
    const article = jsonLdArticle(doc);
    const title = titleFrom(
      doc,
      ["h1.content--title", "h1", ".content--title"],
      ldText(article && (article.headline || article.name)) || doc.title,
    );
    return result({
      title: title.replace(/\s*\|\s*NHK.*/i, ""),
      text,
      source: "fetcher:news:nhk",
      contentSelector: body.selector || "article, main, #news_textbody",
      paywall: detectPaywall(doc, text) || (text.length < MIN_OK && /ご利用にあたって/.test((doc.body && doc.body.innerText) || "")),
      family: "news",
      confident: text.length >= MIN_OK,
      url,
    });
  }

  /* ---------- ④ longform: shared pagination ---------- */

  const LONGFORM_SITES = [
    {
      id: "bunshun",
      hosts: ["bunshun.jp"],
      content: ["#article-body", ".article-body", ".c-article-body", '[itemprop="articleBody"]', "article"],
    },
    {
      id: "toyokeizai",
      hosts: ["toyokeizai.net"],
      content: ["#article-body", "#article-body-inner", ".article-body", ".life__body", '[itemprop="articleBody"]', "article"],
    },
    {
      id: "diamond",
      hosts: ["diamond.jp"],
      content: ["#articleBody", ".c-article-body", ".article-body", '[itemprop="articleBody"]', "article"],
    },
    {
      id: "gendai",
      hosts: ["gendai.media"],
      content: [".article-body", "#article-body", '[itemprop="articleBody"]', "article"],
    },
    {
      id: "president",
      hosts: ["president.jp"],
      content: [".article-body", "#article-body", '[itemprop="articleBody"]', "article"],
    },
  ];

  const LONGFORM_EXCLUDE = [
    ".sns",
    ".share",
    ".related",
    ".recommend",
    ".pager",
    ".pagination",
    ".pagenation",
    "aside",
    ".article-footer",
    ".c-article-footer",
    '[class*="Paywall"]',
    '[class*="paywall"]',
  ];

  function longformSiteFor(url) {
    return LONGFORM_SITES.find((s) => hostMatches(url, s.hosts)) || null;
  }

  function extractLongformBody(doc, site) {
    const article = jsonLdArticle(doc);
    const ld = speechFrom(ldText(article && article.articleBody));
    const nodes = firstEls(doc, site.content);
    const exclude = LONGFORM_EXCLUDE;
    let text = nodes.map((el) => speechFrom(el, { exclude })).filter(Boolean).join("\n\n");
    if (ld.length > Math.max(text.length * 1.15, 400)) text = ld;
    if (text.length < MIN_OK) {
      const picked = pickArticleNode(doc);
      if (picked) text = speechFrom(picked, { exclude });
    }
    return text;
  }

  async function extractLongform(ctx) {
    const url = ctx.url;
    const site = longformSiteFor(url);
    if (!site) return null;
    const doc = ctx.document;
    const collected = await collectPages(doc, url, (d) => extractLongformBody(d, site));
    const article = jsonLdArticle(doc);
    const title = titleFrom(doc, ["h1", ".article-title", ".c-article-title"], ldText(article && (article.headline || article.name)) || doc.title);
    return result({
      title,
      text: collected.text,
      source: "fetcher:longform:" + site.id,
      contentSelector: site.content[0],
      paywall: detectPaywall(doc, collected.text),
      pagesFetched: collected.pages,
      family: "longform",
      confident: collected.text.length >= MIN_OK,
    });
  }

  /* ---------- ⑤ UGC: note / hatena / anond ---------- */

  async function extractNote(ctx) {
    const url = ctx.url;
    const doc = ctx.document;
    let title = titleFrom(doc, ["h1", '[data-testid="noteTitle"]'], doc.title);
    let text = "";
    let paywall = false;

    const keyMatch = url.match(/\/n\/(n[0-9a-zA-Z]+)/);
    if (keyMatch) {
      const api = await fetchJson(`${location.origin}/api/v3/notes/${keyMatch[1]}`);
      const data = api && api.data;
      if (data) {
        title = data.name || title;
        const body = data.body || data.free_body || data.freeBody || "";
        text = speechFrom(body, {
          rubyMode: "ignore",
          exclude: [".o-noteEyecatch-tableOfContents", '[class*="tableOfContents"]'],
        });
        paywall = !data.can_read || (!!data.is_limited && !data.is_purchased);
        if (data.paywall && data.paywall.context && data.paywall.context.is_show_limited_pay_note_paywall) paywall = true;
      }
    }

    if (text.length < MIN_OK) {
      const nextData = parseNextData(doc);
      if (nextData) {
        const raw = longestJsonString(nextData, ["body", "freeBody", "free_body", "name"]);
        const t = speechFrom(raw);
        if (t.length > text.length) text = t;
        const name = longestJsonString(nextData, ["name"]);
        if (name && name.length < 200) title = name;
      }
    }

    if (text.length < MIN_OK) {
      const nodes = firstEls(doc, [
        '[class*="note-common-styles__textnote-body"]',
        'section[data-name="body"]',
        '[itemprop="articleBody"]',
        "article .p-article__body",
        "article section",
      ]);
      const exclude = [
        ".o-noteEyecatch-tableOfContents",
        '[class*="tableOfContents"]',
        '[class*="comment"]',
        "aside",
        "nav",
      ];
      if (nodes.length) {
        text = nodes.map((el) => speechFrom(el, { exclude })).filter(Boolean).join("\n\n");
      } else {
        const article = firstEl(doc, ["article"]);
        if (article) {
          const clone = article.cloneNode(true);
          removeAll(clone, exclude.concat(["header", "footer", '[class*="Author"]', '[class*="profile"]']));
          text = speechFrom(clone, { exclude });
        }
      }
    }

    paywall = paywall || detectPaywall(doc, text);
    return result({
      title: title.replace(/\s*[｜|].*note.*$/i, ""),
      text,
      source: "fetcher:ugc:note",
      contentSelector: "article",
      paywall,
      family: "ugc",
      confident: text.length >= MIN_OK,
    });
  }

  function extractHatena(ctx) {
    const doc = ctx.document;
    const body = firstEl(doc, [".entry-content", "#entry-content", ".hatena-body .entry-content", ".entry-content.hatena-body"]);
    const title = titleFrom(doc, [".entry-title", "h1.entry-title", "h1"], doc.title);
    const text = speechFrom(body || pickArticleNode(doc), {
      exclude: [".comment", "#comment", ".entry-footer", ".share", ".related-entries", "aside", ".hatena-module"],
    });
    return result({
      title,
      text,
      source: "fetcher:ugc:hatena",
      contentSelector: ".entry-content",
      family: "ugc",
      confident: text.length >= MIN_OK,
    });
  }

  function extractAnond(ctx) {
    const doc = ctx.document;
    const sections = [...doc.querySelectorAll(".body .section, #body .section, div.section")];
    const main = sections[0] || firstEl(doc, [".hatena-body .body", ".body", "#body"]);
    if (!main) return null;
    const clone = main.cloneNode(true);
    removeAll(clone, [".sectionfooter", ".sanchor", ".afc", ".ad-in-entry-block", ".pager-section", "aside", "#box2"]);
    const titleEl = clone.querySelector("h1, h2, h3");
    let title = titleEl ? titleEl.textContent.trim() : titleFrom(doc, ["h1"], doc.title);
    const text = speechFrom(clone, { exclude: [] });
    return result({
      title: title.replace(/\s*-\s*はてな匿名ダイアリー.*$/i, ""),
      text,
      source: "fetcher:ugc:anond",
      contentSelector: ".body .section",
      family: "ugc",
      confident: text.length >= MIN_OK,
    });
  }

  /* ---------- registry ---------- */

  function familyOf(url) {
    const h = hostOf(url);
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    if (h.includes("wikipedia.org") && /\/wiki\//.test(path)) return "wikipedia";
    if (h.endsWith("aozora.gr.jp") && /\/cards\//.test(path)) return "aozora";
    if (novelSiteFor(url)) return "novel";
    if (h.endsWith("yahoo.co.jp") && /(^|\.)news\.yahoo\.co\.jp$/.test(h)) return "yahoo";
    if (
      h === "nhk.or.jp" ||
      h.endsWith(".nhk.or.jp") ||
      h === "news.web.nhk" ||
      h.endsWith(".web.nhk") ||
      h === "web.nhk"
    ) {
      return "nhk";
    }
    if (longformSiteFor(url)) return "longform";
    if (h === "note.com" || h.endsWith(".note.com") || h === "note.mu") return "note";
    if (h === "anond.hatelabo.jp") return "anond";
    if (
      h === "d.hatena.ne.jp" ||
      h.endsWith("hatenablog.com") ||
      h.endsWith("hatenablog.jp") ||
      h.endsWith("hateblo.jp") ||
      h.endsWith("hatenadiary.com") ||
      h.endsWith("hatenadiary.jp") ||
      h.endsWith("hatenadiary.org") ||
      h === "blog.hatena.ne.jp"
    ) {
      return "hatena";
    }
    return null;
  }

  async function extract(url, ctx) {
    const kind = familyOf(url);
    if (!kind) return null;
    const bag = { url, document: (ctx && ctx.document) || document, profile: ctx && ctx.profile };
    if (kind === "wikipedia") return extractWikipedia(bag);
    if (kind === "aozora") return extractAozora(bag);
    if (kind === "novel") return extractNovel(bag);
    if (kind === "yahoo") return extractYahoo(bag);
    if (kind === "nhk") return extractNhk(bag);
    if (kind === "longform") return extractLongform(bag);
    if (kind === "note") return extractNote(bag);
    if (kind === "hatena") return extractHatena(bag);
    if (kind === "anond") return extractAnond(bag);
    return null;
  }

  globalThis.__irodoriFetchers = {
    familyOf,
    extract,
    detectPaywall,
    speechFrom,
    applyRuby,
    stripSpeech,
    uniqueTopNodes,
  };
})();
