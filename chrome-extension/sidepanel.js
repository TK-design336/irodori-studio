import {
  splitForSpeech,
  clampChunkChars,
  DEFAULT_CHUNK_CHARS,
} from "./lib/splitText.js";
import { findProfileForUrl, getAllProfiles } from "./lib/profiles.js";
import { PlaybackController } from "./lib/playbackQueue.js";
import { clearCache, cacheStats } from "./lib/cache.js";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:18790",
  token: "",
  speakerId: "",
  rate: 1,
  volume: 0.8,
  autoNextEpisode: true,
  highlightColor: "#facc15",
  chunkChars: DEFAULT_CHUNK_CHARS,
  siteSpeakers: {},
  readLater: [],
};

const els = {
  baseUrl: document.getElementById("baseUrl"),
  token: document.getElementById("token"),
  speaker: document.getElementById("speaker"),
  connStatus: document.getElementById("connStatus"),
  playStatus: document.getElementById("playStatus"),
  btnSave: document.getElementById("btnSave"),
  btnTest: document.getElementById("btnTest"),
  btnRefreshSpeakers: document.getElementById("btnRefreshSpeakers"),
  btnTestSpeak: document.getElementById("btnTestSpeak"),
  btnReadPage: document.getElementById("btnReadPage"),
  btnReadLater: document.getElementById("btnReadLater"),
  btnStop: document.getElementById("btnStop"),
  btnPrev: document.getElementById("btnPrev"),
  btnNext: document.getElementById("btnNext"),
  btnPlayPause: document.getElementById("btnPlayPause"),
  rate: document.getElementById("rate"),
  volume: document.getElementById("volume"),
  rateLabel: document.getElementById("rateLabel"),
  volLabel: document.getElementById("volLabel"),
  autoNextEpisode: document.getElementById("autoNextEpisode"),
  npTitle: document.getElementById("npTitle"),
  npCurrent: document.getElementById("npCurrent"),
  npNext: document.getElementById("npNext"),
  npMeta: document.getElementById("npMeta"),
  npEpisodes: document.getElementById("npEpisodes"),
  btnConcat: document.getElementById("btnConcat"),
  concatFormat: document.getElementById("concatFormat"),
  readLaterList: document.getElementById("readLaterList"),
  btnPlayQueue: document.getElementById("btnPlayQueue"),
  hlColor: document.getElementById("hlColor"),
  hlColorPreview: document.getElementById("hlColorPreview"),
  chunkChars: document.getElementById("chunkChars"),
  btnClearCache: document.getElementById("btnClearCache"),
  btnCopyText: document.getElementById("btnCopyText"),
  cacheStatus: document.getElementById("cacheStatus"),
  profilesJson: document.getElementById("profilesJson"),
  btnSaveProfiles: document.getElementById("btnSaveProfiles"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  settingsOverlay: document.getElementById("settingsOverlay"),
};

let controller = null;
let lastExtract = null;
let queuePlaying = false;
let isReadingUi = false;
let concatBusy = false;
let concatJobId = null;
let concatAbort = false;

function setStatus(el, text, kind) {
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

function formatTime(secs) {
  const s = Math.max(0, Math.floor(secs || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function updatePlayPauseButton(st) {
  const playing = !!(st && st.playing && !st.paused);
  if (playing) {
    els.btnPlayPause.textContent = "||";
    els.btnPlayPause.title = "一時停止";
  } else {
    els.btnPlayPause.textContent = "▶";
    els.btnPlayPause.title = "再生";
  }
}

function resetNowPlaying() {
  els.npTitle.textContent = "読み上げ中: —";
  els.npCurrent.textContent = "▸ 現在: —";
  els.npNext.textContent = "▸ 次: —";
  els.npMeta.textContent = "0:00 / 約 0:00　チャンク 0 / 0";
  els.npEpisodes.textContent = "";
  updatePlayPauseButton({ playing: false, paused: false });
}

function updateNowPlaying(st) {
  if (!st || st.stopped || (!st.playing && !st.paused && !st.waiting && !st.total)) {
    resetNowPlaying();
    return;
  }
  els.npTitle.textContent = `読み上げ中: 「${st.title || "—"}」`;
  els.npCurrent.textContent = `▸ 現在: ${st.currentText || "—"}`;
  els.npNext.textContent = `▸ 次: ${st.nextText || "—"}`;
  els.npMeta.textContent = `${formatTime(st.playedSecs)} / 約 ${formatTime(st.totalSecs)}　チャンク ${Math.min(st.index + 1, st.total)} / ${st.total}${st.waiting ? "　（生成待ち）" : ""}`;
  els.npEpisodes.textContent =
    st.episodesRead > 1 ? `${st.episodesRead} 話まで進行` : "";
  updatePlayPauseButton(st);
  if (st.playing || st.paused || st.waiting) setReadingUi(true);
  else if (st.total > 0 && st.index >= st.total) setReadingUi(false);
}

function setReadingUi(on) {
  isReadingUi = !!on;
  document.body.classList.toggle("is-reading", isReadingUi);
  updateConcatButton();
}

function updateConcatButton() {
  if (concatBusy && !isReadingUi) {
    els.btnConcat.textContent = "合成を停止";
    els.btnConcat.classList.add("danger");
    return;
  }
  els.btnConcat.textContent = "全体を連結して保存";
  els.btnConcat.classList.remove("danger");
}

function updateHlPreview() {
  const c = els.hlColor.value || "#facc15";
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  els.hlColorPreview.style.background = `rgba(${r},${g},${b},0.45)`;
}

function getChunkChars() {
  return clampChunkChars(els.chunkChars?.value ?? DEFAULT_CHUNK_CHARS);
}

function persistChunkChars() {
  const n = getChunkChars();
  if (els.chunkChars) els.chunkChars.value = String(n);
  void chrome.storage.local.set({ chunkChars: n });
}

function openSettings() {
  els.settingsOverlay.hidden = false;
  els.settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  els.settingsOverlay.hidden = true;
  els.settingsOverlay.classList.add("hidden");
}

function downloadBlob(buf, mime, filename) {
  const blob = new Blob([buf], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  els.baseUrl.value = stored.baseUrl || DEFAULTS.baseUrl;
  els.token.value = stored.token || "";
  els.rate.value = stored.rate ?? DEFAULTS.rate;
  els.volume.value = stored.volume ?? DEFAULTS.volume;
  els.autoNextEpisode.checked = stored.autoNextEpisode !== false;
  els.hlColor.value = stored.highlightColor || DEFAULTS.highlightColor;
  els.chunkChars.value = clampChunkChars(stored.chunkChars ?? DEFAULTS.chunkChars);
  els.rateLabel.textContent = `${Number(els.rate.value).toFixed(2)}x`;
  els.volLabel.textContent = `${Math.round(Number(els.volume.value) * 100)}%`;
  updateHlPreview();
  renderReadLater(stored.readLater || []);
  return {
    baseUrl: (stored.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ""),
    token: stored.token || "",
    speakerId: stored.speakerId || "",
    siteSpeakers: stored.siteSpeakers || {},
    readLater: stored.readLater || [],
  };
}

async function saveSettings() {
  const baseUrl = els.baseUrl.value.trim().replace(/\/$/, "");
  const token = els.token.value.trim();
  const speakerId = els.speaker.value || "";
  await chrome.storage.local.set({
    baseUrl,
    token,
    speakerId,
    rate: Number(els.rate.value),
    volume: Number(els.volume.value),
    autoNextEpisode: els.autoNextEpisode.checked,
    highlightColor: els.hlColor.value,
    chunkChars: getChunkChars(),
  });
  setStatus(els.connStatus, "接続設定を保存しました", "ok");
  return { baseUrl, token, speakerId };
}

const ALL_PAGE_ORIGINS = ["http://*/*", "https://*/*"];

function studioOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function currentStudioOrigin() {
  return studioOrigin(els.baseUrl.value.trim().replace(/\/$/, "") || DEFAULTS.baseUrl);
}

function isUserGestureError(err) {
  return /user gesture/i.test(String(err?.message || err || ""));
}

function explainError(err) {
  if (isUserGestureError(err)) {
    return "再生権限の確認に失敗しました。もう一度ボタンを押してください。";
  }
  return String(err?.message || err || "");
}

async function hasOriginPermission(origins) {
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Already-granted check only. Never prompts.
 * chrome.permissions.request() requires a user gesture even when already
 * granted, so polling / auto-next must not call it.
 */
async function ensureHostPermission(baseUrl) {
  const origin = studioOrigin(baseUrl);
  if (!origin) throw new Error("ベース URL が不正です");
  const pattern = origin + "/*";
  if (await hasOriginPermission([pattern])) return;
  if (await hasOriginPermission(ALL_PAGE_ORIGINS)) return;
  throw new Error(
    "Studio へのアクセス権限がありません。設定で「接続テスト」を押してください。",
  );
}

/** Side Panel のクリックでは activeTab が付かないので、操作の最初にサイト権限を取る。 */
async function ensureSiteAccess() {
  if (await hasOriginPermission(ALL_PAGE_ORIGINS)) return;
  throw new Error(
    "ページへのアクセス権限がありません。「このページを読み上げ」をもう一度押し、許可してください。",
  );
}

/**
 * Kick off chrome.permissions.request in the same turn as a click.
 * Do not await anything before calling this.
 */
function requestAccessFromGesture(extraOrigins = []) {
  const origins = [...ALL_PAGE_ORIGINS, ...extraOrigins.filter(Boolean)];
  return chrome.permissions.request({ origins });
}

function requestStudioAccessFromGesture() {
  const origin = currentStudioOrigin();
  if (!origin) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [origin + "/*"] });
}

async function assertGranted(permPromise, deniedMessage) {
  let granted;
  try {
    granted = await permPromise;
  } catch (e) {
    if (isUserGestureError(e)) throw new Error(deniedMessage);
    throw e;
  }
  if (!granted) throw new Error(deniedMessage);
}

async function ensureTabPermission(tab) {
  if (!tab?.url) {
    throw new Error("このタブの URL を取得できません");
  }
  if (/^(chrome|chrome-extension|edge|about|devtools|chrome-search):/i.test(tab.url)) {
    throw new Error("このページでは操作できません");
  }
  await ensureSiteAccess();
}

function isMissingHostPermissionError(err) {
  return /must request permission|Cannot access contents/i.test(String(err?.message || err || ""));
}

async function getConfig() {
  return {
    baseUrl: els.baseUrl.value.trim().replace(/\/$/, "") || DEFAULTS.baseUrl,
    token: els.token.value.trim(),
    speakerId: els.speaker.value || "",
  };
}

async function apiFetch(path, { method = "GET", body, expectBinary = false } = {}) {
  const { baseUrl, token } = await getConfig();
  if (!token) {
    throw new Error("トークンが未設定です（Studio の設定画面からコピーしてください）");
  }
  await ensureHostPermission(baseUrl);

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(
      `Studio に接続できません。アプリが起動しているか、ベース URL（${baseUrl}）を確認してください。（${e.message || e}）`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("認証に失敗しました。トークンを確認してください。");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API エラー ${res.status}: ${text || res.statusText}`);
  }
  if (expectBinary) {
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "audio/wav";
    return { buf, mime };
  }
  return res.json();
}

async function refreshSpeakers(preferredId) {
  const data = await apiFetch("/v1/speakers");
  const speakers = data.speakers || [];
  els.speaker.innerHTML = "";
  if (speakers.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（話者がありません）";
    els.speaker.appendChild(opt);
    return;
  }
  for (const sp of speakers) {
    const opt = document.createElement("option");
    opt.value = sp.id;
    const kind =
      sp.kind === "ref"
        ? "参照"
        : sp.kind === "caption"
          ? "caption"
          : sp.kind === "blend"
            ? "blend"
            : "";
    opt.textContent = kind ? `${sp.name} (${kind})` : sp.name;
    els.speaker.appendChild(opt);
  }
  const pick =
    preferredId && speakers.some((s) => s.id === preferredId)
      ? preferredId
      : speakers[0].id;
  els.speaker.value = pick;
  await chrome.storage.local.set({ speakerId: pick });
}

async function testConnection() {
  setStatus(els.connStatus, "接続中…");
  try {
    await chrome.storage.local.set({
      baseUrl: els.baseUrl.value.trim().replace(/\/$/, ""),
      token: els.token.value.trim(),
      speakerId: els.speaker.value || "",
    });
    const data = await apiFetch("/v1/health");
    setStatus(
      els.connStatus,
      `接続OK — ${data.name || "Irodori Studio"} v${data.version || "?"}（worker loaded: ${data.worker?.loaded ? "yes" : "no"}）`,
      "ok",
    );
    await refreshSpeakers((await chrome.storage.local.get("speakerId")).speakerId);
  } catch (e) {
    setStatus(els.connStatus, String(e.message || e), "err");
  }
}

async function activeTab() {
  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ];
  for (const q of queries) {
    const [tab] = await chrome.tabs.query(q);
    if (tab?.id && tab.url && !/^chrome-extension:/i.test(tab.url)) return tab;
  }
  throw new Error("アクティブなタブがありません");
}

async function getSelectionText() {
  await ensureSiteAccess();
  const tab = await activeTab();
  await ensureTabPermission(tab);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection()?.toString() || "").trim(),
    });
    return (results?.[0]?.result || "").trim();
  } catch (e) {
    if (isMissingHostPermissionError(e)) {
      throw new Error(
        "このページの内容にアクセスできません。拡張機能の「サイトへのアクセス」でこのサイトを許可してください。",
      );
    }
    throw e;
  }
}

async function injectExtract(tabId, profile) {
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

async function injectHighlight(tabId, chunks, color, contentSelector) {
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
    color: color || els.hlColor.value,
  }).catch(() => {});
}

async function siteKey(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function pickSpeakerForUrl(url) {
  // Prefer the speaker currently selected in the UI (user just changed it).
  const current = (els.speaker.value || "").trim();
  if (current) return current;

  const { siteSpeakers, speakerId } = await chrome.storage.local.get([
    "siteSpeakers",
    "speakerId",
  ]);
  const key = await siteKey(url);
  const mapped = siteSpeakers?.[key];
  if (mapped && [...els.speaker.options].some((o) => o.value === mapped)) {
    els.speaker.value = mapped;
    return mapped;
  }
  if (speakerId && [...els.speaker.options].some((o) => o.value === speakerId)) {
    els.speaker.value = speakerId;
    return speakerId;
  }
  return "";
}

/** Apply remembered site speaker when opening/extracting a page (not at mid-UI override). */
async function applySiteSpeakerIfAny(url) {
  const { siteSpeakers } = await chrome.storage.local.get("siteSpeakers");
  const key = await siteKey(url);
  const mapped = siteSpeakers?.[key];
  if (mapped && [...els.speaker.options].some((o) => o.value === mapped)) {
    els.speaker.value = mapped;
    await chrome.storage.local.set({ speakerId: mapped });
  }
}

async function rememberSpeakerForUrl(url, speakerId) {
  const key = await siteKey(url);
  const { siteSpeakers } = await chrome.storage.local.get("siteSpeakers");
  const next = { ...(siteSpeakers || {}), [key]: speakerId };
  await chrome.storage.local.set({ siteSpeakers: next });
}

async function extractPage(tab) {
  await ensureTabPermission(tab);
  const profile = await findProfileForUrl(tab.url || "");
  const result = await injectExtract(tab.id, profile);
  if (!result?.ok || !result.text?.trim()) {
    throw new Error("本文を抽出できませんでした");
  }
  const chunks = splitForSpeech(result.text, getChunkChars());
  return {
    ...result,
    chunks,
    tabId: tab.id,
    profileId: profile?.id || result?.family || null,
    contentSelector: result?.contentSelector || profile?.content || null,
  };
}

async function startReading(extract, { episodesRead = 1 } = {}) {
  const speaker = await pickSpeakerForUrl(extract.url);
  if (!speaker) throw new Error("話者を選択してください");
  await rememberSpeakerForUrl(extract.url, speaker);

  lastExtract = extract;
  await injectHighlight(
    extract.tabId,
    extract.chunks,
    els.hlColor.value,
    extract.contentSelector,
  );
  setReadingUi(true);

  controller = new PlaybackController({
    apiFetch,
    tabId: extract.tabId,
    onStatus: (st) => {
      updateNowPlaying(st);
      if (st.waiting) setStatus(els.playStatus, "生成待ち…", null);
      else if (st.playing) setStatus(els.playStatus, "再生中", "ok");
      else if (st.paused) setStatus(els.playStatus, "一時停止", null);
    },
  });

  if (extract.paywall) {
    setStatus(
      els.playStatus,
      "有料／会員限定の可能性があります。公開されている範囲だけ読み上げます",
      null,
    );
  } else if (extract.pagesFetched > 1) {
    setStatus(els.playStatus, `${extract.pagesFetched} ページ分を結合して読み上げます…`);
  } else {
    setStatus(els.playStatus, "読み上げを開始します…");
  }
  let result;
  try {
    result = await controller.start({
      title: extract.title,
      url: extract.url,
      chunks: extract.chunks,
      speakerId: speaker,
      speed: Number(els.rate.value),
      volume: Number(els.volume.value),
      episodesRead,
    });
  } catch (e) {
    setReadingUi(false);
    resetNowPlaying();
    throw e;
  }

  if (result?.done && els.autoNextEpisode.checked && extract.nextEpisodeUrl) {
    setStatus(els.playStatus, "次話へ移動します…", "ok");
    await chrome.tabs.update(extract.tabId, { url: extract.nextEpisodeUrl });
    await waitTabComplete(extract.tabId);
    const next = await extractPage({ id: extract.tabId, url: extract.nextEpisodeUrl });
    await startReading(next, { episodesRead: episodesRead + 1 });
  } else if (result?.done) {
    setReadingUi(false);
    setStatus(els.playStatus, "読み上げが完了しました", "ok");
  } else {
    setReadingUi(false);
  }
}

function waitTabComplete(tabId) {
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

async function synthesizeAndPlay(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("読み上げるテキストがありません");
  const speaker = els.speaker.value;
  if (!speaker) throw new Error("話者を選択してください");
  setStatus(els.playStatus, "合成中…");
  const { buf, mime } = await apiFetch("/v1/synthesize", {
    method: "POST",
    body: { text: trimmed, speaker, format: "wav" },
    expectBinary: true,
  });
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  await chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" });
  const res = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_PLAY",
    audioBase64: btoa(binary),
    mimeType: mime || "audio/wav",
  });
  if (res?.ok === false) throw new Error(res.error || "再生失敗");
  setStatus(els.playStatus, "再生中…", "ok");
}

function renderReadLater(list) {
  els.readLaterList.innerHTML = "";
  (list || []).forEach((item, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="q-title">${escapeHtml(item.title || item.url)}</span>`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "削除";
    rm.className = "chip";
    rm.addEventListener("click", async () => {
      const { readLater } = await chrome.storage.local.get("readLater");
      const next = (readLater || []).filter((_, j) => j !== i);
      await chrome.storage.local.set({ readLater: next });
      renderReadLater(next);
    });
    li.appendChild(rm);
    els.readLaterList.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function addReadLater(url, title) {
  if (!url) {
    const tab = await activeTab();
    url = tab.url;
    title = tab.title;
  }
  const { readLater } = await chrome.storage.local.get("readLater");
  const list = readLater || [];
  if (list.some((x) => x.url === url)) {
    setStatus(els.playStatus, "既にキューにあります");
    renderReadLater(list);
    return;
  }
  list.push({ url, title: title || url, addedAt: Date.now() });
  await chrome.storage.local.set({ readLater: list });
  renderReadLater(list);
  setStatus(els.playStatus, "後で読むに追加しました", "ok");
}

async function playReadLaterQueue() {
  const { readLater } = await chrome.storage.local.get("readLater");
  const list = [...(readLater || [])];
  if (!list.length) {
    setStatus(els.playStatus, "キューが空です", "err");
    return;
  }
  queuePlaying = true;
  while (list.length && queuePlaying) {
    const item = list.shift();
    await chrome.storage.local.set({ readLater: list });
    renderReadLater(list);
    const tab = await activeTab();
    await chrome.tabs.update(tab.id, { url: item.url });
    await waitTabComplete(tab.id);
    const extract = await extractPage({ id: tab.id, url: item.url });
    await startReading(extract);
  }
  queuePlaying = false;
}

async function waitJobComplete(jobId) {
  for (;;) {
    if (concatAbort) throw new Error("合成を停止しました");
    const st = await apiFetch(`/v1/jobs/${jobId}`);
    if (st.status === "completed") return st;
    if (st.status === "failed") {
      throw new Error(st.error || "ジョブが失敗しました");
    }
    if (st.status === "cancelled") {
      throw new Error("合成を停止しました");
    }
    const done = st.completed ?? 0;
    const total = st.total ?? 0;
    setStatus(els.playStatus, `連結用に合成中… ${done} / ${total}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function downloadJobConcat(jobId, format, title) {
  const { buf, mime } = await apiFetch(`/v1/jobs/${jobId}/concat`, {
    method: "POST",
    body: { silenceMs: 300, format },
    expectBinary: true,
  });
  downloadBlob(buf, mime, `${(title || "irodori").slice(0, 40)}.${format}`);
}

async function concatSave() {
  // Toggle stop when independent concat is running (idle mode)
  if (concatBusy && !isReadingUi) {
    concatAbort = true;
    if (concatJobId) {
      try {
        await apiFetch(`/v1/jobs/${concatJobId}/cancel`, { method: "POST" });
      } catch (_) {
        /* ignore */
      }
    }
    setStatus(els.playStatus, "合成を停止しました");
    return;
  }
  if (concatBusy) return;

  if (!lastExtract?.chunks?.length) {
    // Allow extract-on-demand when idle
    await ensureSiteAccess();
    const tab = await activeTab();
    lastExtract = await extractPage(tab);
  }
  if (!lastExtract?.chunks?.length) {
    throw new Error("連結する本文がありません");
  }

  const speaker = els.speaker.value;
  if (!speaker) throw new Error("話者を選択してください");
  const format = els.concatFormat.value || "wav";
  const title = lastExtract.title;

  // During reading: reuse session job audio (no re-synth of finished lines)
  if (isReadingUi && controller?.jobId) {
    setStatus(els.playStatus, "読み上げ済み音声を連結中…");
    // Wait until current job finishes remaining lines (or use what's done via endpoint)
    concatBusy = true;
    concatAbort = false;
    concatJobId = controller.jobId;
    updateConcatButton();
    try {
      // Prefer waiting for full job so export is complete; abortible via button only when !isReadingUi
      // During reading, transport ■ stops reading — also cancel wait by checking controller
      while (true) {
        if (concatAbort || controller?.aborted) {
          throw new Error("停止されました");
        }
        const st = await apiFetch(`/v1/jobs/${controller.jobId}`);
        if (st.status === "completed" || st.completed >= st.total) break;
        if (st.status === "failed") throw new Error(st.error || "合成失敗");
        if (st.status === "cancelled") throw new Error("停止されました");
        setStatus(
          els.playStatus,
          `連結の準備中（生成 ${st.completed}/${st.total}）…`,
        );
        await new Promise((r) => setTimeout(r, 400));
      }
      await downloadJobConcat(controller.jobId, format, title);
      setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
    } finally {
      concatBusy = false;
      concatJobId = null;
      updateConcatButton();
    }
    return;
  }

  // Idle: independent job, button becomes stop
  concatBusy = true;
  concatAbort = false;
  updateConcatButton();
  setStatus(els.playStatus, "連結用に合成を開始…");
  try {
    const lines = lastExtract.chunks.map((text) => ({ text, speaker }));
    const job = await apiFetch("/v1/jobs", {
      method: "POST",
      body: { lines, format: "wav" },
    });
    concatJobId = job.jobId;
    await waitJobComplete(job.jobId);
    if (concatAbort) throw new Error("合成を停止しました");
    await downloadJobConcat(job.jobId, format, title);
    setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
  } finally {
    concatBusy = false;
    concatJobId = null;
    concatAbort = false;
    updateConcatButton();
  }
}

async function refreshCacheStatus() {
  try {
    const st = await cacheStats();
    const mb = (st.bytes / (1024 * 1024)).toFixed(1);
    const max = (st.maxBytes / (1024 * 1024)).toFixed(0);
    els.cacheStatus.textContent = `キャッシュ: ${st.count} 件 / ${mb} MB（上限 ${max} MB）`;
  } catch {
    els.cacheStatus.textContent = "";
  }
}

// --- events ---
els.btnOpenSettings.addEventListener("click", () => openSettings());
els.btnCloseSettings.addEventListener("click", () => closeSettings());
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});

els.btnSave.addEventListener("click", () => void saveSettings());
els.btnTest.addEventListener("click", () => {
  const permP = requestStudioAccessFromGesture();
  void (async () => {
    try {
      if (currentStudioOrigin()) {
        await assertGranted(permP, "Studio へのアクセス権限が拒否されました");
      }
      await testConnection();
    } catch (e) {
      setStatus(els.connStatus, explainError(e), "err");
    }
  })();
});
els.btnRefreshSpeakers.addEventListener("click", () => {
  const permP = requestStudioAccessFromGesture();
  void (async () => {
    try {
      if (currentStudioOrigin()) {
        await assertGranted(permP, "Studio へのアクセス権限が拒否されました");
      }
      await refreshSpeakers(els.speaker.value);
      setStatus(els.connStatus, "話者一覧を更新しました", "ok");
    } catch (e) {
      setStatus(els.connStatus, explainError(e), "err");
    }
  })();
});
els.btnTestSpeak.addEventListener("click", () => {
  const permP = requestStudioAccessFromGesture();
  void (async () => {
    try {
      if (currentStudioOrigin()) {
        await assertGranted(permP, "Studio へのアクセス権限が拒否されました");
      }
      await synthesizeAndPlay("こんにちは。イロドリスタジオのテスト再生です。");
    } catch (e) {
      setStatus(els.playStatus, explainError(e), "err");
    }
  })();
});
els.btnReadPage.addEventListener("click", () => {
  const origin = currentStudioOrigin();
  const permP = requestAccessFromGesture(origin ? [origin + "/*"] : []);
  void (async () => {
    try {
      await assertGranted(
        permP,
        "ページへのアクセス権限が拒否されました。拡張機能の「サイトへのアクセス」で許可してください。",
      );
      const tab = await activeTab();
      const extract = await extractPage(tab);
      setStatus(
        els.playStatus,
        `抽出: ${extract.source} / ${extract.chunks.length} チャンク`,
        "ok",
      );
      await startReading(extract);
    } catch (e) {
      setReadingUi(false);
      setStatus(els.playStatus, explainError(e), "err");
    }
  })();
});
els.btnReadLater.addEventListener("click", () => {
  void addReadLater().catch((e) =>
    setStatus(els.playStatus, String(e.message || e), "err"),
  );
});
els.btnPlayQueue.addEventListener("click", () => {
  const origin = currentStudioOrigin();
  const permP = requestAccessFromGesture(origin ? [origin + "/*"] : []);
  void (async () => {
    await assertGranted(
      permP,
      "ページへのアクセス権限が拒否されました。拡張機能の「サイトへのアクセス」で許可してください。",
    );
    await playReadLaterQueue();
  })().catch((e) => setStatus(els.playStatus, explainError(e), "err"));
});
els.btnStop.addEventListener("click", () => {
  queuePlaying = false;
  concatAbort = true;
  void (async () => {
    if (controller) await controller.stop();
    resetNowPlaying();
    setReadingUi(false);
    setStatus(els.playStatus, "停止しました");
  })();
});
els.btnPrev.addEventListener("click", () => {
  void controller?.prev();
});
els.btnNext.addEventListener("click", () => {
  void controller?.next();
});
els.btnPlayPause.addEventListener("click", () => {
  void (async () => {
    if (!controller) return;
    await controller.togglePause();
  })();
});
els.rate.addEventListener("input", () => {
  els.rateLabel.textContent = `${Number(els.rate.value).toFixed(2)}x`;
  void controller?.setRate(Number(els.rate.value));
  void chrome.storage.local.set({ rate: Number(els.rate.value) });
});
els.volume.addEventListener("input", () => {
  els.volLabel.textContent = `${Math.round(Number(els.volume.value) * 100)}%`;
  void controller?.setGain(Number(els.volume.value));
  void chrome.storage.local.set({ volume: Number(els.volume.value) });
});
els.autoNextEpisode.addEventListener("change", () => {
  void chrome.storage.local.set({ autoNextEpisode: els.autoNextEpisode.checked });
});
els.speaker.addEventListener("change", () => {
  void (async () => {
    const id = els.speaker.value;
    await chrome.storage.local.set({ speakerId: id });
    try {
      const tab = await activeTab();
      if (tab?.url) await rememberSpeakerForUrl(tab.url, id);
    } catch (_) {
      /* ignore */
    }
    void controller?.changeSpeaker(id);
  })();
});
els.btnConcat.addEventListener("click", () => {
  const origin = currentStudioOrigin();
  const permP = requestAccessFromGesture(origin ? [origin + "/*"] : []);
  void (async () => {
    if (!(concatBusy && !isReadingUi)) {
      await assertGranted(
        permP,
        "ページへのアクセス権限が拒否されました。拡張機能の「サイトへのアクセス」で許可してください。",
      );
    }
    await concatSave();
  })().catch((e) => setStatus(els.playStatus, explainError(e), "err"));
});
els.hlColor.addEventListener("input", () => {
  updateHlPreview();
  void chrome.storage.local.set({ highlightColor: els.hlColor.value });
});
els.chunkChars.addEventListener("change", persistChunkChars);
els.hlColor.addEventListener("change", () => {
  updateHlPreview();
  void chrome.storage.local.set({ highlightColor: els.hlColor.value });
});
els.btnClearCache.addEventListener("click", () => {
  void (async () => {
    await clearCache();
    await refreshCacheStatus();
    setStatus(els.cacheStatus, "キャッシュをクリアしました", "ok");
  })();
});
els.btnCopyText.addEventListener("click", () => {
  void (async () => {
    if (!lastExtract?.text) {
      setStatus(els.playStatus, "コピーする本文がありません", "err");
      return;
    }
    await navigator.clipboard.writeText(lastExtract.text);
    setStatus(els.playStatus, "本文をクリップボードにコピーしました", "ok");
  })();
});
els.btnSaveProfiles.addEventListener("click", () => {
  void (async () => {
    try {
      const raw = els.profilesJson.value.trim();
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error("配列である必要があります");
      await chrome.storage.local.set({ siteProfiles: parsed });
      setStatus(els.playStatus, "プロファイルを保存しました", "ok");
    } catch (e) {
      setStatus(els.playStatus, `プロファイル JSON エラー: ${e.message || e}`, "err");
    }
  })();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "READ_TEXT" && typeof msg.text === "string") {
    void synthesizeAndPlay(msg.text).catch((e) =>
      setStatus(els.playStatus, String(e.message || e), "err"),
    );
  }
  if (msg?.type === "READ_PAGE") {
    void (async () => {
      await ensureSiteAccess();
      const tab = msg.tabId
        ? await chrome.tabs.get(msg.tabId)
        : await activeTab();
      const extract = await extractPage(tab);
      await startReading(extract);
    })().catch((e) => {
      setReadingUi(false);
      setStatus(els.playStatus, explainError(e), "err");
    });
  }
  if (msg?.type === "ADD_READ_LATER") {
    void addReadLater(msg.url, msg.title);
  }
  if (msg?.type === "SEEK_CHUNK" && typeof msg.index === "number") {
    void controller?.seekTo(msg.index);
  }
});

void (async () => {
  const s = await loadSettings();
  await refreshCacheStatus();
  updateConcatButton();
  try {
    const bundled = await getAllProfiles();
    const { siteProfiles } = await chrome.storage.local.get("siteProfiles");
    els.profilesJson.value = JSON.stringify(siteProfiles || [], null, 2);
    if (!siteProfiles) {
      els.profilesJson.placeholder = `同梱 ${bundled.length} 件。空の [] で同梱のみ使用`;
    }
  } catch (_) {
    /* ignore */
  }
  if (!s.token) {
    openSettings();
    setStatus(els.connStatus, "初回セットアップ: URL とトークンを入力してください");
  } else {
    try {
      await refreshSpeakers(s.speakerId);
      try {
        const tab = await activeTab();
        if (tab?.url) await applySiteSpeakerIfAny(tab.url);
      } catch (_) {
        /* ignore */
      }
      setStatus(els.connStatus, "設定を読み込みました", "ok");
    } catch (_) {
      openSettings();
      setStatus(
        els.connStatus,
        "Studio 未接続です。URL とトークンを確認してください。",
        "err",
      );
    }
  }
})();
