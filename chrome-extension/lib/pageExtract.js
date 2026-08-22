/** Page extract / highlight injection (usable from SW and side panel). */

import { findProfileForUrl } from "./profiles.js";
import { splitForSpeech, clampChunkChars, DEFAULT_CHUNK_CHARS } from "./splitText.js";
import { ensureSiteAccess, isMissingHostPermissionError } from "./studioApi.js";

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
  const result = await injectExtract(tab.id, profile);
  if (!result?.ok || !result.text?.trim()) {
    throw new Error("本文を抽出できませんでした");
  }
  const chunks = splitForSpeech(result.text, clampChunkChars(chunkChars ?? DEFAULT_CHUNK_CHARS));
  return {
    ...result,
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
