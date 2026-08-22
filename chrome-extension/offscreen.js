/**
 * Offscreen playback with pitch-preserving speed.
 * Uses HTMLAudioElement.preservesPitch (atempo-like) instead of
 * AudioBufferSourceNode.playbackRate which changes pitch.
 *
 * A silent loop + runtime port keep this document (and the SW) alive while
 * a session is active, including TTS wait gaps when speech audio is idle.
 */

let rate = 1;
let gainValue = 0.8;
const blobs = new Map(); // index -> Blob
let objectUrl = null;
let audio = null;
let currentIndex = -1;
let lastFinishedIndex = -1;
let chunkPlaying = false;
let paused = false;
let sessionActive = false;
let playGeneration = 0;

/** Keep AUDIO_PLAYBACK valid between speech chunks. */
let keepAliveCtx = null;
let keepAliveAudio = null;

function startSilentKeepalive() {
  if (keepAliveCtx || keepAliveAudio) return;
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    osc.frequency.value = 40;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    keepAliveCtx = ctx;
    return;
  } catch (_) {
    /* fall through */
  }
  const el = new Audio(
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA",
  );
  el.loop = true;
  el.volume = 0.01;
  el.play().catch(() => {});
  keepAliveAudio = el;
}

function stopSilentKeepalive() {
  if (keepAliveCtx) {
    try {
      keepAliveCtx.close();
    } catch (_) {
      /* ignore */
    }
    keepAliveCtx = null;
  }
  if (!keepAliveAudio) return;
  try {
    keepAliveAudio.pause();
    keepAliveAudio.removeAttribute("src");
    keepAliveAudio.load();
  } catch (_) {
    /* ignore */
  }
  keepAliveAudio = null;
}

function connectKeepalivePort() {
  try {
    const port = chrome.runtime.connect({ name: "offscreen-keepalive" });
    port.onDisconnect.addListener(() => {
      setTimeout(connectKeepalivePort, 250);
    });
  } catch (_) {
    setTimeout(connectKeepalivePort, 500);
  }
}

connectKeepalivePort();

function revokeUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function stopAudio(markFinished) {
  playGeneration++;
  if (audio) {
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch (_) {
      /* ignore */
    }
    audio = null;
  }
  revokeUrl();
  if (markFinished && currentIndex >= 0) {
    lastFinishedIndex = currentIndex;
  }
  chunkPlaying = false;
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "audio/wav" });
}

function applyRateAndGain(el) {
  if (!el) return;
  el.preservesPitch = true;
  // Chromium alias (older)
  if ("mozPreservesPitch" in el) el.mozPreservesPitch = true;
  if ("webkitPreservesPitch" in el) el.webkitPreservesPitch = true;
  el.playbackRate = rate;
  el.volume = Math.max(0, Math.min(1, gainValue));
}

function state() {
  return {
    ok: true,
    currentIndex,
    lastFinishedIndex,
    chunkPlaying,
    paused,
    durationSecs: audio && Number.isFinite(audio.duration) ? audio.duration : null,
    sessionActive,
  };
}

function playIndex(index) {
  const blob = blobs.get(index);
  if (!blob) {
    return Promise.resolve({
      ok: false,
      error: `チャンク ${index} が未準備です`,
    });
  }

  stopAudio(false);
  const gen = playGeneration;
  currentIndex = index;
  paused = false;

  revokeUrl();
  objectUrl = URL.createObjectURL(blob);
  audio = new Audio(objectUrl);
  applyRateAndGain(audio);
  chunkPlaying = true;

  return new Promise((resolve) => {
    audio.onended = () => {
      if (gen !== playGeneration) return;
      chunkPlaying = false;
      lastFinishedIndex = index;
      paused = false;
    };
    audio.onerror = () => {
      if (gen !== playGeneration) return;
      chunkPlaying = false;
      resolve({ ok: false, error: "音声の再生に失敗しました" });
    };
    audio
      .play()
      .then(() => resolve({ ok: true, durationSecs: audio.duration || null }))
      .catch((e) => {
        chunkPlaying = false;
        resolve({ ok: false, error: String(e) });
      });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  const handle = async () => {
    switch (msg.type) {
      case "OFFSCREEN_SESSION_START": {
        sessionActive = true;
        blobs.clear();
        currentIndex = -1;
        lastFinishedIndex = -1;
        rate = msg.rate || 1;
        gainValue = msg.gain ?? 0.8;
        stopAudio(false);
        startSilentKeepalive();
        return { ok: true };
      }
      case "OFFSCREEN_SESSION_END": {
        sessionActive = false;
        stopSilentKeepalive();
        return { ok: true };
      }
      case "OFFSCREEN_QUEUE_CHUNK": {
        const blob = base64ToBlob(msg.audioBase64, msg.mimeType || "audio/wav");
        blobs.set(msg.index, blob);
        // Probe duration via decode if needed — optional quick Audio
        return { ok: true };
      }
      case "OFFSCREEN_PLAY_INDEX": {
        return playIndex(msg.index);
      }
      case "OFFSCREEN_PAUSE": {
        if (!audio || !chunkPlaying) {
          paused = true;
          chunkPlaying = false;
          return { ok: true };
        }
        audio.pause();
        paused = true;
        chunkPlaying = false;
        return { ok: true };
      }
      case "OFFSCREEN_RESUME": {
        if (!paused) return { ok: true };
        paused = false;
        if (!audio) return { ok: true };
        applyRateAndGain(audio);
        chunkPlaying = true;
        try {
          await audio.play();
        } catch (e) {
          chunkPlaying = false;
          return { ok: false, error: String(e) };
        }
        return { ok: true };
      }
      case "OFFSCREEN_STOP":
      case "OFFSCREEN_STOP_CHUNK": {
        stopAudio(false);
        paused = false;
        if (msg.type === "OFFSCREEN_STOP") {
          blobs.clear();
          sessionActive = false;
          currentIndex = -1;
          stopSilentKeepalive();
        }
        return { ok: true };
      }
      case "OFFSCREEN_SKIP": {
        stopAudio(false);
        paused = false;
        return { ok: true };
      }
      case "OFFSCREEN_SET_RATE": {
        rate = msg.rate || 1;
        if (audio) applyRateAndGain(audio);
        return { ok: true };
      }
      case "OFFSCREEN_SET_GAIN": {
        gainValue = msg.gain ?? 0.8;
        if (audio) applyRateAndGain(audio);
        return { ok: true };
      }
      case "OFFSCREEN_GET_STATE":
        return state();
      case "OFFSCREEN_PLAY": {
        // Phase 1 single-shot
        blobs.clear();
        blobs.set(0, base64ToBlob(msg.audioBase64, msg.mimeType || "audio/wav"));
        return playIndex(0);
      }
      default:
        return null;
    }
  };

  const types = new Set([
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
  if (!types.has(msg.type)) return;

  handle()
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
