/**
 * Page-context extract script (classic, not a module).
 * Inject after vendor/Readability.js and content/fetchers.js.
 * Call via: chrome.scripting.executeScript({ func: () => __irodoriExtract(opts), args: [opts] })
 */
(function () {
  "use strict";

  const F = globalThis.__irodoriFetchers || null;

  function isInvisible(el) {
    if (!(el instanceof Element)) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return true;
    }
    return false;
  }

  function cleanNode(root, opts) {
    const exclude = (opts && opts.exclude) || [];
    for (const sel of exclude) {
      try {
        root.querySelectorAll(sel).forEach((n) => n.remove());
      } catch (_) {
        /* ignore bad selector */
      }
    }
    root.querySelectorAll("pre, code, script, style, noscript, svg, iframe").forEach((n) => n.remove());
    root.querySelectorAll("sup").forEach((n) => n.remove());

    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const toRemove = [];
    let cur;
    while ((cur = walk.nextNode())) {
      if (isInvisible(cur)) toRemove.push(cur);
    }
    toRemove.forEach((n) => n.remove());
  }

  function applyRuby(root, rubyMode) {
    if (F && F.applyRuby) {
      F.applyRuby(root, rubyMode);
      return;
    }
    if (rubyMode !== "reading") {
      root.querySelectorAll("rt, rp").forEach((n) => n.remove());
      return;
    }
    root.querySelectorAll("ruby").forEach((ruby) => {
      const rts = [...ruby.querySelectorAll("rt")].map((r) => r.textContent).join("");
      ruby.replaceWith(document.createTextNode(rts || ruby.textContent || ""));
    });
  }

  function stripUrlsAndFootnotes(text) {
    if (F && F.stripSpeech) return F.stripSpeech(text);
    return String(text || "")
      .replace(/https?:\/\/[^\s]+/gi, " ")
      .replace(/\bwww\.[^\s]+/gi, " ")
      .replace(/\[\d+\]/g, "")
      .replace(/-{3,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function uniqueTopNodes(nodeList) {
    if (F && F.uniqueTopNodes) return F.uniqueTopNodes(nodeList);
    const nodes = [...nodeList];
    return nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  }

  function matchHost(pattern, url) {
    try {
      const re = new RegExp(
        "^" +
          pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*") +
          "$",
      );
      return re.test(url);
    } catch {
      return false;
    }
  }

  function extractViaProfile(profile, opts) {
    if (!profile) return null;
    const rubyMode = profile.rubyMode || "ignore";
    let title = document.title || "";
    let text = "";
    let nextEpisodeUrl = null;
    if (profile.title) {
      const tEl = document.querySelector(profile.title);
      if (tEl) title = (tEl.textContent || "").trim() || title;
    }
    if (profile.content) {
      const parts = [];
      const nodes = uniqueTopNodes(document.querySelectorAll(profile.content));
      nodes.forEach((el) => {
        const clone = el.cloneNode(true);
        cleanNode(clone, { exclude: profile.exclude || [] });
        applyRuby(clone, rubyMode);
        if (opts.mathMode !== "read") {
          clone.querySelectorAll(".MathJax, .katex, math, .ltx_Math").forEach((n) => n.remove());
        }
        const t = stripUrlsAndFootnotes(clone.innerText || clone.textContent || "");
        if (t) parts.push(t);
      });
      text = parts.join("\n\n");
    }
    if (profile.nextEpisode) {
      const a = document.querySelector(profile.nextEpisode);
      if (a && a.href) nextEpisodeUrl = a.href;
    }
    if (!text) return null;
    return {
      title,
      text,
      nextEpisodeUrl,
      source: "profile:" + (profile.id || "custom"),
      contentSelector: profile.content || null,
      confident: text.length >= 80,
    };
  }

  function extractViaReadability(opts, rubyMode) {
    if (typeof Readability === "undefined") {
      return stripUrlsAndFootnotes(document.body ? document.body.innerText || "" : "");
    }
    const clone = document.cloneNode(true);
    cleanNode(clone.documentElement || clone, {
      exclude: (opts.profile && opts.profile.exclude) || [],
    });
    try {
      const article = new Readability(clone).parse();
      if (!article) return "";
      const div = document.createElement("div");
      div.innerHTML = article.content || "";
      cleanNode(div, {});
      applyRuby(div, rubyMode);
      return stripUrlsAndFootnotes(div.innerText || article.textContent || "");
    } catch {
      return stripUrlsAndFootnotes(document.body ? document.body.innerText || "" : "");
    }
  }

  function pack(url, title, text, extra) {
    extra = extra || {};
    const blocks = String(text || "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t, i) => ({ text: t, index: i }));
    return {
      ok: true,
      url,
      title: title || document.title || "",
      text: text || "",
      blocks,
      nextEpisodeUrl: extra.nextEpisodeUrl || null,
      source: extra.source || "readability",
      paywall: !!extra.paywall,
      contentSelector: extra.contentSelector || null,
      pagesFetched: extra.pagesFetched || 1,
      family: extra.family || null,
      noFallback: !!extra.noFallback,
      error: extra.error || null,
    };
  }

  /**
   * @param {{ profile?: object|null, mathMode?: string }} opts
   */
  async function extract(opts) {
    opts = opts || {};
    const profile = opts.profile || null;
    const rubyMode = (profile && profile.rubyMode) || "ignore";
    const url = location.href;

    let fetched = null;
    if (F && typeof F.extract === "function") {
      try {
        fetched = await F.extract(url, { document, profile });
      } catch (e) {
        fetched = null;
      }
    }

    if (
      !fetched &&
      F &&
      typeof F.parseGoogleDocument === "function" &&
      F.parseGoogleDocument(url)
    ) {
      fetched = {
        title: document.title || "",
        text: "",
        source: "fetcher:gdocs:export",
        family: "gdocs",
        noFallback: true,
        contentSelector: "__none__",
        error: "Google ドキュメントの本文を取得できませんでした",
      };
    }

    if (fetched && fetched.noFallback) {
      return pack(url, fetched.title, fetched.text, fetched);
    }

    if (fetched && fetched.confident && fetched.text && fetched.text.length >= 80) {
      return pack(url, fetched.title, fetched.text, fetched);
    }

    const fromProfile = extractViaProfile(profile, opts);
    if (fromProfile && fromProfile.text.length >= (fetched && fetched.text ? fetched.text.length : 0) && fromProfile.text.length >= 80) {
      return pack(url, fromProfile.title, fromProfile.text, {
        ...fromProfile,
        paywall: fetched && fetched.paywall,
        nextEpisodeUrl: fromProfile.nextEpisodeUrl || (fetched && fetched.nextEpisodeUrl),
      });
    }

    if (fetched && fetched.text && fetched.text.length >= 40) {
      return pack(url, fetched.title, fetched.text, fetched);
    }

    let title = (fetched && fetched.title) || (fromProfile && fromProfile.title) || document.title || "";
    let text = (fromProfile && fromProfile.text) || (fetched && fetched.text) || "";
    const readable = extractViaReadability(opts, rubyMode);
    if (readable && readable.length > text.length) {
      text = readable;
      title = title || document.title;
      return pack(url, title, text, {
        source: text && fromProfile ? fromProfile.source + "+readability-fallback" : "readability",
        nextEpisodeUrl: (fromProfile && fromProfile.nextEpisodeUrl) || (fetched && fetched.nextEpisodeUrl),
        paywall: fetched && fetched.paywall,
        contentSelector: fromProfile && fromProfile.contentSelector,
        family: fetched && fetched.family,
      });
    }

    if (!text) text = readable;
    return pack(url, title, text, {
      source: fetched ? fetched.source + "+fallback" : fromProfile ? fromProfile.source : "readability",
      nextEpisodeUrl: (fetched && fetched.nextEpisodeUrl) || (fromProfile && fromProfile.nextEpisodeUrl),
      paywall: fetched && fetched.paywall,
      contentSelector: (fetched && fetched.contentSelector) || (fromProfile && fromProfile.contentSelector),
      family: fetched && fetched.family,
    });
  }

  globalThis.__irodoriExtract = extract;
  globalThis.__irodoriMatchHost = matchHost;
})();
