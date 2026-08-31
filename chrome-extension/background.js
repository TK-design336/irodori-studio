/** Service worker: Side Panel, Offscreen lifecycle, playback session host. */

import { setKeepaliveRecover } from "./lib/keepaliveConnect.js";
import { closeOffscreen, ensureOffscreen, hasOffscreen } from "./lib/offscreenDoc.js";
import {
  playerStart,
  playerStop,
  playerPause,
  playerResume,
  playerTogglePause,
  playerNext,
  playerPrev,
  playerSeek,
  playerSetRate,
  playerSetGain,
  playerSetSilenceMs,
  playerChangeSpeaker,
  playerReadTab,
  playerReadText,
  playerPlayQueue,
  getPlayerSnapshot,
  recoverOffscreenSession,
} from "./lib/playerHost.js";

setKeepaliveRecover(() => {
  const snap = getPlayerSnapshot();
  if (!snap.playing) return;
  return ensureOffscreen().then(() => recoverOffscreenSession());
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "irodori-read-selection",
      title: "選択範囲を Irodori で読み上げ",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "irodori-read-page",
      title: "このページを Irodori で読み上げ",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "irodori-read-later",
      title: "後で読むに追加",
      contexts: ["page"],
    });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function openSidePanel(tab) {
  if (tab?.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (_) {
      /* ignore */
    }
  }
}

async function pingSidePanel(message, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      await chrome.runtime.sendMessage(message);
      return true;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return false;
}

async function addReadLater(url, title) {
  if (!url) return { ok: false, error: "URL がありません" };
  const { readLater } = await chrome.storage.local.get("readLater");
  const list = readLater || [];
  if (list.some((x) => x.url === url)) return { ok: true, exists: true };
  list.push({ url, title: title || url, addedAt: Date.now() });
  await chrome.storage.local.set({ readLater: list });
  return { ok: true };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await chrome.permissions.request({
      origins: ["http://*/*", "https://*/*"],
    });
  } catch (_) {
    /* ignore; extract will surface a clearer error */
  }
  if (info.menuItemId === "irodori-read-selection") {
    const text = (info.selectionText || "").trim();
    if (!text) return;
    await openSidePanel(tab);
    try {
      await ensureOffscreen();
      await playerReadText({
        text,
        title: "選択範囲",
        url: tab?.url ? `selection://${tab.url}` : "selection://",
        tabId: tab?.id ?? null,
      });
    } catch (e) {
      await pingSidePanel({
        type: "PLAYER_ERROR",
        error: String(e?.message || e),
      });
    }
    return;
  }
  if (info.menuItemId === "irodori-read-page") {
    await openSidePanel(tab);
    try {
      await ensureOffscreen();
      await playerReadTab({ tabId: tab?.id });
    } catch (e) {
      await pingSidePanel({
        type: "PLAYER_ERROR",
        error: String(e?.message || e),
      });
    }
    return;
  }
  if (info.menuItemId === "irodori-read-later") {
    await addReadLater(tab?.url, tab?.title);
    await openSidePanel(tab);
  }
});

const OFFSCREEN_TYPES = new Set([
  "OFFSCREEN_SESSION_START",
  "OFFSCREEN_SESSION_END",
  "OFFSCREEN_QUEUE_CHUNK",
  "OFFSCREEN_PLAY_INDEX",
  "OFFSCREEN_PAUSE",
  "OFFSCREEN_RESUME",
  "OFFSCREEN_STOP",
  "OFFSCREEN_STOP_CHUNK",
  "OFFSCREEN_SKIP",
  "OFFSCREEN_SET_RATE",
  "OFFSCREEN_SET_GAIN",
  "OFFSCREEN_GET_STATE",
  "OFFSCREEN_PLAY",
]);

const PLAYER_TYPES = new Set([
  "PLAYER_START",
  "PLAYER_STOP",
  "PLAYER_PAUSE",
  "PLAYER_RESUME",
  "PLAYER_TOGGLE_PAUSE",
  "PLAYER_NEXT",
  "PLAYER_PREV",
  "PLAYER_SEEK",
  "PLAYER_SET_RATE",
  "PLAYER_SET_GAIN",
  "PLAYER_SET_SILENCE_MS",
  "PLAYER_CHANGE_SPEAKER",
  "PLAYER_READ_TAB",
  "PLAYER_PLAY_QUEUE",
  "PLAYER_GET_STATE",
  "PLAYER_ADD_READ_LATER",
]);

function handlePlayer(msg) {
  switch (msg.type) {
    case "PLAYER_START":
      return playerStart(msg);
    case "PLAYER_STOP":
      return playerStop();
    case "PLAYER_PAUSE":
      return playerPause();
    case "PLAYER_RESUME":
      return playerResume();
    case "PLAYER_TOGGLE_PAUSE":
      return playerTogglePause();
    case "PLAYER_NEXT":
      return playerNext();
    case "PLAYER_PREV":
      return playerPrev();
    case "PLAYER_SEEK":
      return playerSeek(msg.index);
    case "PLAYER_SET_RATE":
      return playerSetRate(msg.rate);
    case "PLAYER_SET_GAIN":
      return playerSetGain(msg.gain);
    case "PLAYER_SET_SILENCE_MS":
      playerSetSilenceMs(msg.silenceMs);
      return { ok: true };
    case "PLAYER_CHANGE_SPEAKER":
      return playerChangeSpeaker(msg.speakerId);
    case "PLAYER_READ_TAB":
      return playerReadTab(msg);
    case "PLAYER_PLAY_QUEUE":
      return playerPlayQueue(msg);
    case "PLAYER_GET_STATE":
      return getPlayerSnapshot();
    case "PLAYER_ADD_READ_LATER":
      return addReadLater(msg.url, msg.title);
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "ENSURE_OFFSCREEN") {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "PLAY_AUDIO") {
    ensureOffscreen()
      .then(() =>
        chrome.runtime.sendMessage({
          type: "OFFSCREEN_PLAY",
          audioBase64: msg.audioBase64,
          mimeType: msg.mimeType || "audio/wav",
        }),
      )
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "STOP_AUDIO") {
    (async () => {
      if (!(await hasOffscreen())) return { ok: true };
      try {
        await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
      } catch (_) {
        /* document may already be gone */
      }
      await closeOffscreen();
      return { ok: true };
    })()
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (PLAYER_TYPES.has(msg.type)) {
    const needsDoc =
      msg.type !== "PLAYER_GET_STATE" &&
      msg.type !== "PLAYER_STOP" &&
      msg.type !== "PLAYER_ADD_READ_LATER" &&
      msg.type !== "PLAYER_SET_SILENCE_MS";
    const run = async () => {
      if (needsDoc) await ensureOffscreen();
      const result = await handlePlayer(msg);
      return result ?? { ok: true };
    };
    run()
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // Side panel / content → do not re-broadcast OFFSCREEN_* (offscreen listens directly).
  if (OFFSCREEN_TYPES.has(msg.type)) {
    return;
  }

  // Click-to-seek from content script → playback host (not the side panel)
  if (msg.type === "IRODORI_SEEK_CHUNK") {
    playerSeek(msg.index)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
