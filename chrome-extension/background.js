/** Service worker: Side Panel, Offscreen lifecycle, message relay. */

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASON = "AUDIO_PLAYBACK";

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
    await pingSidePanel({ type: "READ_TEXT", text });
    return;
  }
  if (info.menuItemId === "irodori-read-page") {
    await openSidePanel(tab);
    await pingSidePanel({ type: "READ_PAGE", tabId: tab?.id });
    return;
  }
  if (info.menuItemId === "irodori-read-later") {
    await openSidePanel(tab);
    await pingSidePanel({
      type: "ADD_READ_LATER",
      url: tab?.url,
      title: tab?.title,
    });
  }
});

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: "Gapless speech playback while switching tabs",
  });
}

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
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }))
      .then((r) => sendResponse(r ?? { ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // Side panel / content → do not re-broadcast OFFSCREEN_* (offscreen listens directly).
  if (OFFSCREEN_TYPES.has(msg.type)) {
    return;
  }

  // Click-to-seek from content script → side panel
  if (msg.type === "IRODORI_SEEK_CHUNK") {
    chrome.runtime
      .sendMessage({
        type: "SEEK_CHUNK",
        index: msg.index,
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
});
