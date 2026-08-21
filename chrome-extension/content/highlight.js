/**
 * Highlight: locate chunk ranges once (no DOM wrap), wrap only the active chunk.
 */
(function () {
  "use strict";

  const STYLE_ID = "irodori-highlight-style";
  const MARK_CLASS = "irodori-hl-chunk";

  /** @type {{ start: number, end: number }|null}[] */
  let chunkRanges = [];
  let contentRoot = null;
  let userScrollUntil = 0;
  let scrollListening = false;
  let ignoreScrollUntil = 0;
  let highlightColor = "rgba(250, 204, 21, 0.45)";

  function ensureStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.documentElement.appendChild(el);
    }
    el.textContent = `
      .${MARK_CLASS} {
        background: ${highlightColor} !important;
        border-radius: 2px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      .${MARK_CLASS}.is-active {
        outline: 2px solid rgba(234, 179, 8, 0.95);
      }
    `;
  }

  function clearMarks() {
    document.querySelectorAll("." + MARK_CLASS).forEach((n) => {
      const parent = n.parentNode;
      if (!parent) return;
      while (n.firstChild) parent.insertBefore(n.firstChild, n);
      parent.removeChild(n);
      parent.normalize();
    });
  }

  function onUserScrollIntent() {
    if (Date.now() < ignoreScrollUntil) return;
    userScrollUntil = Date.now() + 4000;
  }

  function ensureScrollListener() {
    if (scrollListening) return;
    scrollListening = true;
    // Prefer intentional user gestures; ignore our own scrollIntoView via ignoreScrollUntil
    window.addEventListener("wheel", onUserScrollIntent, { passive: true });
    window.addEventListener("touchmove", onUserScrollIntent, { passive: true });
    window.addEventListener("keydown", (e) => {
      if (
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === " "
      ) {
        onUserScrollIntent();
      }
    });
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return `rgba(250, 204, 21, ${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function resolveRoot(selector) {
    if (selector) {
      for (const sel of String(selector)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch (_) {
          /* invalid selector */
        }
      }
    }
    return (
      document.querySelector("#novel_honbun") ||
      document.querySelector(".p-novel__body") ||
      document.querySelector(".widget-episodeBody") ||
      document.querySelector("article") ||
      document.body
    );
  }

  function compactify(s) {
    return String(s || "").replace(/\s+/g, "");
  }

  function buildCompactIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (
          tag === "SCRIPT" ||
          tag === "STYLE" ||
          tag === "NOSCRIPT" ||
          tag === "SVG" ||
          tag === "RT" ||
          tag === "RP"
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest("script, style, noscript, svg, rt, rp")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest("." + MARK_CLASS)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let compact = "";
    const map = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        map.push({ node, offset: i });
        compact += text[i];
      }
    }
    return { compact, map };
  }

  /**
   * Find needle at/after cursor. Exact first; else longest prefix (≥ minKeep).
   * Returns { start, end } with end = start + matchedLength (never overshoots).
   */
  function findNeedle(compact, needle, cursor, minKeep) {
    if (!needle || needle.length < 2) return null;
    let idx = compact.indexOf(needle, cursor);
    if (idx >= 0) return { start: idx, end: idx + needle.length };

    // Progressive shortening from full length — matched length only
    const floor = Math.min(minKeep, needle.length);
    for (let len = needle.length - 1; len >= floor; len--) {
      const prefix = needle.slice(0, len);
      idx = compact.indexOf(prefix, cursor);
      if (idx >= 0) return { start: idx, end: idx + len };
    }

    // Last resort: search from document start (still exact / prefix, not overshoot)
    idx = compact.indexOf(needle);
    if (idx >= 0 && idx >= cursor - 2) {
      return { start: idx, end: idx + needle.length };
    }
    for (let len = Math.min(needle.length, 40); len >= floor; len--) {
      idx = compact.indexOf(needle.slice(0, len), cursor);
      if (idx >= 0) return { start: idx, end: idx + len };
    }
    return null;
  }

  function wrapCompactRange(map, start, end, index) {
    if (start < 0 || end <= start || end > map.length) return null;
    const a = map[start];
    const b = map[end - 1];
    if (!a || !b) return null;

    const attachClick = (mark) => {
      mark.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: "IRODORI_SEEK_CHUNK", index });
      });
    };

    const makeMark = () => {
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS + " is-active";
      mark.dataset.irodoriIndex = String(index);
      attachClick(mark);
      return mark;
    };

    try {
      if (a.node === b.node) {
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset + 1);
        const mark = makeMark();
        range.surroundContents(mark);
        return mark;
      }

      // Multi-node: use surroundContents per contiguous text-node slice only
      let first = null;
      const seen = new Set();
      for (let i = start; i < end; i++) {
        const { node } = map[i];
        if (seen.has(node)) continue;
        seen.add(node);
        let lo = Infinity;
        let hi = -1;
        for (let j = start; j < end; j++) {
          if (map[j].node !== node) continue;
          lo = Math.min(lo, map[j].offset);
          hi = Math.max(hi, map[j].offset);
        }
        if (lo === Infinity) continue;
        try {
          const range = document.createRange();
          range.setStart(node, lo);
          range.setEnd(node, hi + 1);
          const mark = makeMark();
          range.surroundContents(mark);
          if (!first) first = mark;
        } catch (_) {
          /* skip broken node (e.g. partial element) */
        }
      }
      return first;
    } catch (_) {
      return null;
    }
  }

  function locateChunks(chunkTexts, selector) {
    ensureStyle();
    ensureScrollListener();
    clearMarks();
    contentRoot = resolveRoot(selector);
    chunkRanges = new Array(chunkTexts.length).fill(null);

    const { compact } = buildCompactIndex(contentRoot);
    let cursor = 0;

    for (let i = 0; i < chunkTexts.length; i++) {
      const needle = compactify(chunkTexts[i]);
      if (needle.length < 2) continue;
      const minKeep = Math.min(12, needle.length);
      const hit = findNeedle(compact, needle, cursor, minKeep);
      if (!hit) continue;
      chunkRanges[i] = hit;
      cursor = hit.end;
    }
  }

  function highlightIndex(index) {
    ensureStyle();
    ensureScrollListener();
    clearMarks();

    const range = chunkRanges[index];
    if (!range || !contentRoot) return;

    // Rebuild map on clean DOM (marks cleared) so offsets still match locate pass
    const { map } = buildCompactIndex(contentRoot);
    if (range.end > map.length) return;

    const mark = wrapCompactRange(map, range.start, range.end, index);
    if (mark) maybeAutoscroll(mark);
  }

  function maybeAutoscroll(el) {
    if (Date.now() < userScrollUntil) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const margin = vh * 0.18;
    const fullyVisible = rect.top >= margin && rect.bottom <= vh - margin;
    if (fullyVisible) return;
    ignoreScrollUntil = Date.now() + 800;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "IRODORI_HIGHLIGHT") {
      highlightIndex(msg.index);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "IRODORI_SET_CHUNKS") {
      locateChunks(msg.chunks || [], msg.contentSelector || null);
      sendResponse({
        ok: true,
        mapped: chunkRanges.filter(Boolean).length,
        total: chunkRanges.length,
      });
      return true;
    }
    if (msg.type === "IRODORI_CLEAR_HIGHLIGHT") {
      clearMarks();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "IRODORI_SET_HIGHLIGHT_COLOR") {
      const c = msg.color || "#facc15";
      highlightColor = c.startsWith("#") ? hexToRgba(c, 0.45) : c;
      ensureStyle();
      sendResponse({ ok: true });
      return true;
    }
  });

  globalThis.__irodoriHighlightReady = true;
})();
