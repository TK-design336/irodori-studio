/**
 * Playback session owner. Lives in the service worker so closing the
 * side panel does not abort reading or leave Studio jobs running.
 */

import { PlaybackController } from "./playbackQueue.js";
import { apiFetch } from "./studioApi.js";
import { extractPage, injectHighlight, waitTabComplete } from "./pageExtract.js";
import { clampChunkChars, DEFAULT_CHUNK_CHARS } from "./splitText.js";

let controller = null;
let lastStatus = null;
let lastExtract = null;
let queuePlaying = false;
let sessionGen = 0;
let playOpts = null;

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastStatus(st) {
  lastStatus = st;
  chrome.storage.session.set({ playerStatus: st }).catch(() => {});
  post({ type: "PLAYER_STATUS", status: st });
}

function persistExtract(extract) {
  lastExtract = extract
    ? {
        title: extract.title || "",
        url: extract.url || "",
        text: extract.text || "",
        chunks: extract.chunks || [],
        tabId: extract.tabId ?? null,
        nextEpisodeUrl: extract.nextEpisodeUrl || null,
        contentSelector: extract.contentSelector || null,
        paywall: !!extract.paywall,
        pagesFetched: extract.pagesFetched || 1,
      }
    : null;
  chrome.storage.session.set({ playerExtract: lastExtract }).catch(() => {});
  if (lastExtract) post({ type: "PLAYER_EXTRACT", extract: lastExtract });
}

export function getPlayerSnapshot() {
  return {
    status: lastStatus,
    extract: lastExtract,
    jobId: controller?.jobId || null,
    playing: !!(controller && (controller.playing || controller.paused)),
    queuePlaying,
  };
}

export async function playerStop() {
  sessionGen += 1;
  queuePlaying = false;
  await chrome.storage.session.set({ queuePlaying: false }).catch(() => {});
  if (controller) {
    try {
      await controller.stop(true);
    } catch (_) {
      /* ignore */
    }
  }
  broadcastStatus({
    stopped: true,
    playing: false,
    paused: false,
    waiting: false,
    total: 0,
    jobId: null,
  });
}

export async function playerPause() {
  if (controller) await controller.pause();
}

export async function playerResume() {
  if (controller) await controller.resume();
}

export async function playerTogglePause() {
  if (controller) await controller.togglePause();
}

export async function playerNext() {
  if (controller) await controller.next();
}

export async function playerPrev() {
  if (controller) await controller.prev();
}

export async function playerSeek(index) {
  if (controller) await controller.seekTo(index);
}

export async function playerSetRate(rate) {
  if (controller) await controller.setRate(rate);
}

export async function playerSetGain(gain) {
  if (controller) await controller.setGain(gain);
}

export async function playerChangeSpeaker(speakerId) {
  if (controller) await controller.changeSpeaker(speakerId);
}

export async function recoverOffscreenSession() {
  if (!controller || (!controller.playing && !controller.paused)) return;
  controller.invalidateOffscreenBuffers();
  try {
    await controller.sendOffscreen({
      type: "OFFSCREEN_SESSION_START",
      rate: controller.speed,
      gain: controller.volume,
    });
    controller._skipToken += 1;
    await controller.sendOffscreen({ type: "OFFSCREEN_STOP_CHUNK" });
  } catch (_) {
    /* ensureOffscreen + retry happens in sendOffscreen */
  }
}

async function loadPlaySettings() {
  const stored = await chrome.storage.local.get([
    "speakerId",
    "rate",
    "volume",
    "highlightColor",
    "chunkChars",
    "autoNextEpisode",
  ]);
  return {
    speakerId: stored.speakerId || "",
    speed: stored.rate ?? 1,
    volume: stored.volume ?? 0.8,
    highlightColor: stored.highlightColor || "#facc15",
    chunkChars: clampChunkChars(stored.chunkChars ?? DEFAULT_CHUNK_CHARS),
    autoNext: stored.autoNextEpisode !== false,
  };
}

async function resolveSpeaker(preferred) {
  if (preferred) return preferred;
  const { speakerId } = await chrome.storage.local.get("speakerId");
  if (speakerId) return speakerId;
  const data = await apiFetch("/v1/speakers");
  const speakers = data.speakers || [];
  if (!speakers.length) throw new Error("話者を選択してください");
  return speakers[0].id;
}

/**
 * Start a session from already-extracted chunks. Returns after the job is
 * created; the playback loop continues in the background.
 */
export async function playerStart(opts) {
  const gen = ++sessionGen;
  const speakerId = await resolveSpeaker(opts.speakerId);
  if (gen !== sessionGen) return { ok: true, superseded: true };

  persistExtract(opts);
  playOpts = {
    ...opts,
    speakerId,
    speed: opts.speed ?? 1,
    volume: opts.volume ?? 0.8,
    episodesRead: opts.episodesRead || 1,
  };

  if (controller) {
    try {
      await controller.stop(false);
    } catch (_) {
      /* ignore */
    }
  }
  if (gen !== sessionGen) return { ok: true, superseded: true };

  controller = new PlaybackController({
    apiFetch,
    tabId: playOpts.tabId ?? null,
    onStatus: (st) => {
      broadcastStatus({ ...st, jobId: controller?.jobId || null });
    },
  });

  const sessionOpts = playOpts;
  const loopPromise = controller.start({
    title: sessionOpts.title,
    url: sessionOpts.url,
    chunks: sessionOpts.chunks,
    speakerId: sessionOpts.speakerId,
    speed: sessionOpts.speed,
    volume: sessionOpts.volume,
    episodesRead: sessionOpts.episodesRead,
  });

  void (async () => {
    try {
      const result = await loopPromise;
      if (gen !== sessionGen) return;
      await onSessionDone(result, sessionOpts, gen);
    } catch (e) {
      if (gen !== sessionGen) return;
      post({ type: "PLAYER_ERROR", error: String(e?.message || e) });
    }
  })();

  return { ok: true };
}

async function onSessionDone(result, opts, gen) {
  if (!result?.done) return;
  const { autoNextEpisode } = await chrome.storage.local.get("autoNextEpisode");
  const autoNext = autoNextEpisode !== false;
  if (autoNext && opts.nextEpisodeUrl && opts.tabId != null) {
    post({ type: "PLAYER_PROGRESS", message: "次話へ移動します…" });
    await continueNextEpisode(opts, gen);
    return;
  }
  if (queuePlaying) {
    await playNextQueueItem(gen);
    return;
  }
  post({ type: "PLAYER_FINISHED", reason: "done" });
}

async function continueNextEpisode(opts, gen) {
  try {
    await chrome.tabs.update(opts.tabId, { url: opts.nextEpisodeUrl });
    await waitTabComplete(opts.tabId);
    if (gen !== sessionGen) return;
    const settings = await loadPlaySettings();
    const extract = await extractPage(
      { id: opts.tabId, url: opts.nextEpisodeUrl },
      settings.chunkChars,
    );
    if (gen !== sessionGen) return;
    await injectHighlight(
      extract.tabId,
      extract.chunks,
      opts.highlightColor || settings.highlightColor,
      extract.contentSelector,
    );
    await playerStart({
      ...extract,
      speakerId: opts.speakerId || settings.speakerId,
      speed: opts.speed ?? settings.speed,
      volume: opts.volume ?? settings.volume,
      episodesRead: (opts.episodesRead || 1) + 1,
      highlightColor: opts.highlightColor || settings.highlightColor,
    });
  } catch (e) {
    if (gen !== sessionGen) return;
    post({ type: "PLAYER_ERROR", error: String(e?.message || e) });
  }
}

export async function playerReadTab(opts) {
  const settings = await loadPlaySettings();
  const tab = opts.tabId != null ? await chrome.tabs.get(opts.tabId) : null;
  if (!tab) throw new Error("タブが見つかりません");
  const extract = await extractPage(tab, opts.chunkChars ?? settings.chunkChars);
  await injectHighlight(
    extract.tabId,
    extract.chunks,
    opts.highlightColor || settings.highlightColor,
    extract.contentSelector,
  );
  return playerStart({
    ...extract,
    speakerId: opts.speakerId || settings.speakerId,
    speed: opts.speed ?? settings.speed,
    volume: opts.volume ?? settings.volume,
    episodesRead: 1,
    highlightColor: opts.highlightColor || settings.highlightColor,
  });
}

export async function playerPlayQueue(opts) {
  sessionGen += 1;
  if (controller) {
    try {
      await controller.stop(false);
    } catch (_) {
      /* ignore */
    }
  }
  queuePlaying = true;
  await chrome.storage.session.set({ queuePlaying: true }).catch(() => {});
  return playNextQueueItem(sessionGen, opts);
}

async function playNextQueueItem(gen, ctx) {
  if (gen !== sessionGen) return { ok: true, superseded: true };

  const { readLater } = await chrome.storage.local.get("readLater");
  const list = [...(readLater || [])];
  if (!list.length) {
    queuePlaying = false;
    await chrome.storage.session.set({ queuePlaying: false }).catch(() => {});
    post({ type: "PLAYER_FINISHED", reason: "queue-empty" });
    return { ok: true };
  }
  const item = list.shift();
  await chrome.storage.local.set({ readLater: list });
  if (gen !== sessionGen) return { ok: true, superseded: true };

  const settings = await loadPlaySettings();
  const speed = ctx?.speed ?? playOpts?.speed ?? settings.speed;
  const volume = ctx?.volume ?? playOpts?.volume ?? settings.volume;
  const speakerId = ctx?.speakerId || playOpts?.speakerId || settings.speakerId;
  const highlightColor =
    ctx?.highlightColor || playOpts?.highlightColor || settings.highlightColor;
  const chunkChars = ctx?.chunkChars ?? settings.chunkChars;

  let tabId = ctx?.tabId ?? playOpts?.tabId;
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id;
  }
  if (tabId == null) throw new Error("アクティブなタブがありません");

  await chrome.tabs.update(tabId, { url: item.url });
  await waitTabComplete(tabId);
  if (gen !== sessionGen) return { ok: true, superseded: true };
  const extract = await extractPage({ id: tabId, url: item.url }, chunkChars);
  if (gen !== sessionGen) return { ok: true, superseded: true };
  await injectHighlight(extract.tabId, extract.chunks, highlightColor, extract.contentSelector);
  return playerStart({
    ...extract,
    speakerId,
    speed,
    volume,
    episodesRead: 1,
    highlightColor,
  });
}
