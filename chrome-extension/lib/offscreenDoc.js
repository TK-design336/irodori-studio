/** Offscreen document lifecycle (shared by SW and playback). */

export const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASON = "AUDIO_PLAYBACK";

/** Serialize create/close so a stop cannot race the next session start. */
let lifecycle = Promise.resolve();

function enqueue(fn) {
  const run = lifecycle.then(fn, fn);
  lifecycle = run.catch(() => {});
  return run;
}

export async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen() {
  return enqueue(async () => {
    if (await hasOffscreen()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [OFFSCREEN_REASON],
        justification: "Gapless speech playback while the side panel is closed or tabs change",
      });
    } catch (e) {
      if (await hasOffscreen()) return;
      throw e;
    }
  });
}

export async function closeOffscreen() {
  return enqueue(async () => {
    if (!(await hasOffscreen())) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {
      /* already closed */
    }
  });
}
