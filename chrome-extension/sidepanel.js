import { clampChunkChars, DEFAULT_CHUNK_CHARS, splitForSpeech, sanitizeForSpeech, hasSpeakable } from "./lib/splitText.js";
import { getAllProfiles } from "./lib/profiles.js";
import {
  clearCache,
  cacheStats,
  loadCachedPageAudio,
  putPageAudio,
  beginPageCache,
} from "./lib/cache.js";
import {
  apiFetch as studioApiFetch,
  ALL_PAGE_ORIGINS,
  studioOrigin,
  ensureSiteAccess,
  isMissingHostPermissionError,
} from "./lib/studioApi.js";
import {
  extractPage as extractPageFromTab,
  injectHighlight,
  ensureTabPermission,
} from "./lib/pageExtract.js";
import {
  DEFAULT_SILENCE_MS,
  clampSilenceMs,
} from "./lib/playbackSettings.js";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:50021",
  token: "",
  speakerId: "",
  rate: 1,
  volume: 0.8,
  autoNextEpisode: true,
  highlightColor: "#facc15",
  chunkChars: DEFAULT_CHUNK_CHARS,
  silenceMs: DEFAULT_SILENCE_MS,
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
  silenceMs: document.getElementById("silenceMs"),
  btnClearCache: document.getElementById("btnClearCache"),
  btnCopyText: document.getElementById("btnCopyText"),
  cacheStatus: document.getElementById("cacheStatus"),
  profilesJson: document.getElementById("profilesJson"),
  btnSaveProfiles: document.getElementById("btnSaveProfiles"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  settingsOverlay: document.getElementById("settingsOverlay"),
};

let lastExtract = null;
let lastPlayerStatus = null;
let isReadingUi = false;
let concatBusy = false;
let concatJobId = null;
let concatAbort = false;

function playerSend(msg) {
  return chrome.runtime.sendMessage(msg);
}

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

function getSilenceMs() {
  return clampSilenceMs(els.silenceMs?.value ?? DEFAULT_SILENCE_MS);
}

function persistSilenceMs() {
  const n = getSilenceMs();
  if (els.silenceMs) els.silenceMs.value = String(n);
  void chrome.storage.local.set({ silenceMs: n });
  void playerSend({ type: "PLAYER_SET_SILENCE_MS", silenceMs: n });
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

/** Page title shown as 読み上げ中: 「…」 — prefer live status, then last extract. */
function concatPageTitle() {
  const live = String(lastPlayerStatus?.title || "").trim();
  if (live) return live;
  return String(lastExtract?.title || "").trim();
}

const CONCAT_NAME_MAX = 80;

function concatDownloadName(title, format) {
  const ext = String(format || "wav").replace(/[^a-z0-9]/gi, "") || "wav";
  let name = String(title || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (name.length > CONCAT_NAME_MAX) {
    name = name.slice(0, CONCAT_NAME_MAX).trim().replace(/[. ]+$/g, "");
  }
  return `${name || "irodori"}.${ext}`;
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
  els.silenceMs.value = clampSilenceMs(stored.silenceMs ?? DEFAULTS.silenceMs);
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
    silenceMs: getSilenceMs(),
  });
  setStatus(els.connStatus, "接続設定を保存しました", "ok");
  return { baseUrl, token, speakerId };
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

async function getConfig() {
  return {
    baseUrl: els.baseUrl.value.trim().replace(/\/$/, "") || DEFAULTS.baseUrl,
    token: els.token.value.trim(),
    speakerId: els.speaker.value || "",
  };
}

async function apiFetch(path, opts = {}) {
  return studioApiFetch(path, { ...opts, config: await getConfig() });
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

function extractPage(tab) {
  return extractPageFromTab(tab, getChunkChars());
}

function applyPlayerStatus(st) {
  lastPlayerStatus = st || null;
  updateNowPlaying(st);
  if (!st) return;
  if (st.waiting) setStatus(els.playStatus, "生成待ち…", null);
  else if (st.playing) setStatus(els.playStatus, "再生中", "ok");
  else if (st.paused) setStatus(els.playStatus, "一時停止", null);
}

async function restorePlayerFromHost() {
  try {
    const snap = await playerSend({ type: "PLAYER_GET_STATE" });
    if (!snap) return;
    if (snap.extract) lastExtract = snap.extract;
    if (snap.status) applyPlayerStatus(snap.status);
    if (snap.playing || snap.status?.playing || snap.status?.paused || snap.status?.waiting) {
      setReadingUi(true);
    }
  } catch (_) {
    /* host idle */
  }
}

async function startReadingFromText(text, { title = "選択範囲" } = {}) {
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned || !hasSpeakable(cleaned)) throw new Error("読み上げるテキストがありません");
  const chunks = splitForSpeech(cleaned, getChunkChars());
  if (!chunks.length) throw new Error("読み上げるテキストがありません");
  const tab = await activeTab();
  await startReading({
    title,
    url: `selection://${tab.url}`,
    tabId: tab.id,
    chunks,
    text: cleaned,
    paywall: false,
    pagesFetched: 1,
    nextEpisodeUrl: null,
    contentSelector: null,
  });
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

  const res = await playerSend({
    type: "PLAYER_START",
    title: extract.title,
    url: extract.url,
    chunks: extract.chunks,
    speakerId: speaker,
    speed: Number(els.rate.value),
    volume: Number(els.volume.value),
    episodesRead,
    tabId: extract.tabId,
    nextEpisodeUrl: extract.nextEpisodeUrl || null,
    contentSelector: extract.contentSelector || null,
    text: extract.text || "",
    paywall: !!extract.paywall,
    pagesFetched: extract.pagesFetched || 1,
    highlightColor: els.hlColor.value,
    silenceMs: getSilenceMs(),
    chunkChars: getChunkChars(),
  });
  if (res?.ok === false) {
    setReadingUi(false);
    resetNowPlaying();
    throw new Error(res.error || "読み上げを開始できませんでした");
  }
}

async function synthesizeAndPlay(text) {
  const trimmed = sanitizeForSpeech(text);
  if (!trimmed || !hasSpeakable(trimmed)) throw new Error("読み上げるテキストがありません");
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
  if (!(readLater || []).length) {
    setStatus(els.playStatus, "キューが空です", "err");
    return;
  }
  const tab = await activeTab();
  setReadingUi(true);
  setStatus(els.playStatus, "キューを再生します…");
  const res = await playerSend({
    type: "PLAYER_PLAY_QUEUE",
    tabId: tab.id,
    speakerId: els.speaker.value || "",
    speed: Number(els.rate.value),
    volume: Number(els.volume.value),
    highlightColor: els.hlColor.value,
    chunkChars: getChunkChars(),
    silenceMs: getSilenceMs(),
  });
  if (res?.ok === false) {
    setReadingUi(false);
    throw new Error(res.error || "キューを再生できませんでした");
  }
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
    body: { silenceMs: getSilenceMs(), format },
    expectBinary: true,
  });
  downloadBlob(buf, mime, concatDownloadName(title, format));
}

async function cacheJobLinesToPage(jobId, { url, title, speakerId, chunkChars, chunks }) {
  try {
    await beginPageCache({ url, title, speakerId, chunkChars, chunks });
    const st = await apiFetch(`/v1/jobs/${jobId}`);
    const lines = st.lines || [];
    for (let i = 0; i < chunks.length; i++) {
      const line = lines[i];
      if (!line || (line.status !== "done" && !line.ready)) continue;
      const { buf } = await apiFetch(`/v1/jobs/${jobId}/lines/${i}`, {
        expectBinary: true,
      });
      await putPageAudio({
        url,
        title,
        speakerId,
        chunkChars,
        index: i,
        text: chunks[i],
        blob: new Blob([buf], { type: "audio/wav" }),
      });
    }
  } catch (_) {
    /* cache is best-effort */
  }
}

async function concatFromBlobs(blobs, format, title) {
  const fd = new FormData();
  fd.append("silenceMs", String(getSilenceMs()));
  fd.append("format", format);
  for (let i = 0; i < blobs.length; i++) {
    fd.append("files", blobs[i], `${String(i).padStart(4, "0")}.wav`);
  }
  const { buf, mime } = await apiFetch("/v1/concat-files", {
    method: "POST",
    form: fd,
    expectBinary: true,
  });
  downloadBlob(buf, mime, concatDownloadName(title, format));
}

async function fillMissingFromJob(missing, blobs, chunks, { url, title, speaker }) {
  const lines = missing.map((i) => ({ text: chunks[i], speaker }));
  const job = await apiFetch("/v1/jobs", {
    method: "POST",
    body: { lines, format: "wav", split: false },
  });
  concatJobId = job.jobId;
  await waitJobComplete(job.jobId);
  if (concatAbort) throw new Error("合成を停止しました");
  const chunkChars = getChunkChars();
  for (let k = 0; k < missing.length; k++) {
    const i = missing[k];
    const { buf } = await apiFetch(`/v1/jobs/${job.jobId}/lines/${k}`, {
      expectBinary: true,
    });
    const blob = new Blob([buf], { type: "audio/wav" });
    blobs[i] = blob;
    await putPageAudio({
      url,
      title,
      speakerId: speaker,
      chunkChars,
      index: i,
      text: chunks[i],
      blob,
    });
  }
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
  const title = concatPageTitle();
  const url = lastExtract.url || "";
  const chunks = lastExtract.chunks;
  const chunkChars = getChunkChars();

  concatBusy = true;
  concatAbort = false;
  updateConcatButton();

  try {
    const cached = await loadCachedPageAudio({ url, speakerId: speaker, chunks });
    if (cached.missing.length === 0) {
      setStatus(els.playStatus, "キャッシュから連結しています…");
      await concatFromBlobs(cached.blobs, format, title);
      setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
      return;
    }

    const sessionJobId = lastPlayerStatus?.jobId;
    if (isReadingUi && sessionJobId) {
      setStatus(els.playStatus, "読み上げ済み音声を連結中…");
      concatJobId = sessionJobId;
      while (true) {
        if (concatAbort || lastPlayerStatus?.stopped) {
          throw new Error("停止されました");
        }
        const st = await apiFetch(`/v1/jobs/${sessionJobId}`);
        if (st.status === "completed" || st.completed >= st.total) break;
        if (st.status === "failed") throw new Error(st.error || "合成失敗");
        if (st.status === "cancelled") throw new Error("停止されました");
        setStatus(
          els.playStatus,
          `連結の準備中（生成 ${st.completed}/${st.total}）…`,
        );
        await new Promise((r) => setTimeout(r, 400));
      }
      await downloadJobConcat(sessionJobId, format, title);
      void cacheJobLinesToPage(sessionJobId, {
        url,
        title,
        speakerId: speaker,
        chunkChars,
        chunks,
      });
      setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
      return;
    }

    setStatus(
      els.playStatus,
      cached.missing.length < chunks.length
        ? `未キャッシュ ${cached.missing.length} 文を合成しています…`
        : "連結用に合成を開始…",
    );
    await beginPageCache({ url, title, speakerId: speaker, chunkChars, chunks });

    if (cached.missing.length === chunks.length) {
      const lines = chunks.map((text) => ({ text, speaker }));
      const job = await apiFetch("/v1/jobs", {
        method: "POST",
        body: { lines, format: "wav", split: false },
      });
      concatJobId = job.jobId;
      await waitJobComplete(job.jobId);
      if (concatAbort) throw new Error("合成を停止しました");
      await downloadJobConcat(job.jobId, format, title);
      void cacheJobLinesToPage(job.jobId, {
        url,
        title,
        speakerId: speaker,
        chunkChars,
        chunks,
      });
      setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
      return;
    }

    await fillMissingFromJob(cached.missing, cached.blobs, chunks, {
      url,
      title,
      speaker,
    });
    if (concatAbort) throw new Error("合成を停止しました");
    setStatus(els.playStatus, "キャッシュから連結しています…");
    await concatFromBlobs(cached.blobs, format, title);
    setStatus(els.playStatus, "連結ファイルを保存しました", "ok");
  } finally {
    concatBusy = false;
    concatJobId = null;
    concatAbort = false;
    updateConcatButton();
    void refreshCacheStatus();
  }
}

async function refreshCacheStatus() {
  try {
    const st = await cacheStats();
    const mb = (st.bytes / (1024 * 1024)).toFixed(1);
    const max = (st.maxBytes / (1024 * 1024)).toFixed(0);
    const pages = st.pageCount ? ` / ${st.pageCount} ページ` : "";
    els.cacheStatus.textContent = `キャッシュ: ${st.count} 件${pages} / ${mb} MB（上限 ${max} MB）`;
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
  concatAbort = true;
  void (async () => {
    await playerSend({ type: "PLAYER_STOP" });
    resetNowPlaying();
    setReadingUi(false);
    setStatus(els.playStatus, "停止しました");
  })();
});
els.btnPrev.addEventListener("click", () => {
  void playerSend({ type: "PLAYER_PREV" });
});
els.btnNext.addEventListener("click", () => {
  void playerSend({ type: "PLAYER_NEXT" });
});
els.btnPlayPause.addEventListener("click", () => {
  void playerSend({ type: "PLAYER_TOGGLE_PAUSE" });
});
els.rate.addEventListener("input", () => {
  els.rateLabel.textContent = `${Number(els.rate.value).toFixed(2)}x`;
  void playerSend({ type: "PLAYER_SET_RATE", rate: Number(els.rate.value) });
  void chrome.storage.local.set({ rate: Number(els.rate.value) });
});
els.volume.addEventListener("input", () => {
  els.volLabel.textContent = `${Math.round(Number(els.volume.value) * 100)}%`;
  void playerSend({ type: "PLAYER_SET_GAIN", gain: Number(els.volume.value) });
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
    void playerSend({ type: "PLAYER_CHANGE_SPEAKER", speakerId: id });
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
els.silenceMs.addEventListener("change", persistSilenceMs);
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
const COPY_LABEL = "本文をコピー（Studio 用）";
let copyFlashTimer = 0;

function flashCopyButton(label, kind = "ok") {
  const btn = els.btnCopyText;
  btn.textContent = label;
  btn.classList.toggle("btn-flash-ok", kind === "ok");
  clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => {
    btn.textContent = COPY_LABEL;
    btn.classList.remove("btn-flash-ok");
  }, 1800);
}

els.btnCopyText.addEventListener("click", () => {
  void (async () => {
    if (!lastExtract?.text) {
      els.btnCopyText.textContent = "本文を取得中…";
      try {
        await ensureSiteAccess();
        const tab = await activeTab();
        lastExtract = await extractPage(tab);
      } catch (_) {
        /* fall through */
      }
    }
    if (!lastExtract?.text) {
      flashCopyButton("本文がありません", "err");
      return;
    }
    await navigator.clipboard.writeText(lastExtract.text);
    flashCopyButton("コピーしました");
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
    void startReadingFromText(msg.text).catch((e) =>
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
    void playerSend({ type: "PLAYER_SEEK", index: msg.index });
  }
  if (msg?.type === "PLAYER_STATUS" && msg.status) {
    applyPlayerStatus(msg.status);
  }
  if (msg?.type === "PLAYER_EXTRACT" && msg.extract) {
    lastExtract = msg.extract;
  }
  if (msg?.type === "PLAYER_PROGRESS" && msg.message) {
    setStatus(els.playStatus, msg.message, "ok");
  }
  if (msg?.type === "PLAYER_ERROR" && msg.error) {
    setReadingUi(false);
    setStatus(els.playStatus, explainError(msg.error), "err");
  }
  if (msg?.type === "PLAYER_FINISHED") {
    if (msg.reason === "done") {
      setReadingUi(false);
      setStatus(els.playStatus, "読み上げが完了しました", "ok");
    } else if (msg.reason === "queue-empty") {
      setReadingUi(false);
      setStatus(els.playStatus, "キューの再生が完了しました", "ok");
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.readLater) {
    renderReadLater(changes.readLater.newValue || []);
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
  await restorePlayerFromHost();
})();
