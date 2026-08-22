/** Offscreen document lifecycle (shared by SW and playback). */

export const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_REASON = "AUDIO_PLAYBACK";

export async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification: "Gapless speech playback while the side panel is closed or tabs change",
  });
}
