/**
 * Register the offscreen keepalive listener before heavy SW modules load.
 * background.js must import this file first so chrome.runtime.connect()
 * from offscreen.html has a receiver during playerHost evaluation.
 */

export const KEEPALIVE_PORT_NAME = "offscreen-keepalive";

let recover = null;

export function setKeepaliveRecover(fn) {
  recover = fn;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (typeof recover !== "function") return;
    try {
      const result = recover();
      if (result && typeof result.then === "function") {
        result.catch(() => {});
      }
    } catch (_) {
      /* ignore */
    }
  });
});
