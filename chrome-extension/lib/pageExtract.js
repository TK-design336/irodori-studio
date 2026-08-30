/** Page extract / highlight injection (usable from SW and side panel). */

import { findProfileForUrl } from "./profiles.js";
import { splitForSpeech, sanitizeForSpeech, clampChunkChars, DEFAULT_CHUNK_CHARS } from "./splitText.js";
import { ensureSiteAccess, isMissingHostPermissionError } from "./studioApi.js";

const GDOCS_NO_HIGHLIGHT = "__none__";

export function parseGoogleDocumentUrl(url) {
  try {
    const u = new URL(url || "");
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (host !== "docs.google.com") return null;
    const m = u.pathname.match(
      /^\/(?:a\/[^/]+\/)?document\/(?:u\/(\d+)\/)?d\/(?!e\/)([a-zA-Z0-9_-]{10,})(?:\/([^/?#]*))?/i,
    );
    if (!m) return null;
    const action = String(m[3] || "").toLowerCase();
    if (/^(pub|pubhtml)$/.test(action)) return null;
    return { userIndex: m[1] || null, id: m[2] };
  } catch {
    return null;
  }
}

function looksLikeHtmlDocument(text, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  const head = String(text || "").slice(0, 256).trim();
  return /^<!DOCTYPE html/i.test(head) || /^<html[\s>]/i.test(head);
}

function googleDocExportUrls(info) {
  const origin = "https://docs.google.com";
  const path =
    info.userIndex != null
      ? `/document/u/${info.userIndex}/d/${info.id}`
      : `/document/d/${info.id}`;
  return [
    `${origin}${path}/export?format=txt`,
    `${origin}/feeds/download/documents/export/Export?id=${encodeURIComponent(info.id)}&exportFormat=txt`,
  ];
}

/** Extension-context fetch (host perms, no page CORS) if the in-page export fails. */
async function exportGoogleDocFromExtension(tabUrl) {
  const info = parseGoogleDocumentUrl(tabUrl);
  if (!info) return null;
  for (const exportUrl of googleDocExportUrls(info)) {
    try {
      const res = await fetch(exportUrl, { credentials: "include", redirect: "follow" });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") || "";
      const raw = await res.text();
      if (looksLikeHtmlDocument(raw, contentType)) continue;
      const text = sanitizeForSpeech(raw);
      if (text) return { text, source: "fetcher:gdocs:export" };
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function ensureTabPermission(tab) {
  if (!tab?.url) {
    throw new Error("このタブの URL を取得できません");
  }
  if (/^(chrome|chrome-extension|edge|about|devtools|chrome-search):/i.test(tab.url)) {
    throw new Error("このページでは操作できません");
  }
  await ensureSiteAccess();
}

export async function injectExtract(tabId, profile) {
  const run = async () => {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/Readability.js", "content/fetchers.js", "content/extract-page.js"],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (p) => globalThis.__irodoriExtract({ profile: p }),
      args: [profile],
    });
    return result;
  };
  try {
    return await run();
  } catch (e) {
    if (!isMissingHostPermissionError(e)) throw e;
    await ensureSiteAccess();
    try {
      return await run();
    } catch (e2) {
      throw new Error(
        "このページの内容にアクセスできません。拡張機能の「サイトへのアクセス」でこのサイトを許可してください。",
      );
    }
  }
}

export async function injectHighlight(tabId, chunks, color, contentSelector) {
  if (!tabId || contentSelector === GDOCS_NO_HIGHLIGHT) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/highlight.js"],
    });
  } catch (e) {
    if (isMissingHostPermissionError(e)) {
      await ensureSiteAccess();
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/highlight.js"],
      });
    } else {
      throw e;
    }
  }
  await chrome.tabs.sendMessage(tabId, {
    type: "IRODORI_SET_CHUNKS",
    chunks,
    contentSelector: contentSelector || null,
  }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, {
    type: "IRODORI_SET_HIGHLIGHT_COLOR",
    color: color || "#facc15",
  }).catch(() => {});
}

export async function extractPage(tab, chunkChars) {
  await ensureTabPermission(tab);
  const profile = await findProfileForUrl(tab.url || "");
  let result = await injectExtract(tab.id, profile);
  if ((!result?.ok || !result.text?.trim()) && parseGoogleDocumentUrl(tab.url || "")) {
    const exported = await exportGoogleDocFromExtension(tab.url);
    if (exported?.text?.trim()) {
      const title = String(result?.title || tab.title || "")
        .replace(/\s*[-–—|｜]\s*Google\s*(ドキュメント|Docs|Documents?)\s*$/i, "")
        .trim();
      result = {
        ok: true,
        url: tab.url,
        title: title || result?.title || tab.title || "",
        text: exported.text,
        source: exported.source,
        family: "gdocs",
        contentSelector: GDOCS_NO_HIGHLIGHT,
        paywall: false,
        pagesFetched: 1,
        nextEpisodeUrl: null,
        noFallback: true,
        error: null,
      };
    }
  }
  if (!result?.ok || !result.text?.trim()) {
    throw new Error(result?.error || "本文を抽出できませんでした");
  }
  const text = sanitizeForSpeech(result.text);
  if (!text.trim()) {
    throw new Error(result?.error || "本文を抽出できませんでした");
  }
  const chunks = splitForSpeech(text, clampChunkChars(chunkChars ?? DEFAULT_CHUNK_CHARS));
  return {
    ...result,
    text,
    chunks,
    tabId: tab.id,
    profileId: profile?.id || result?.family || null,
    contentSelector: result?.contentSelector || profile?.content || null,
  };
}

export function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
