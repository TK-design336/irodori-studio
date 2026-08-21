/** Site profile matching (user overrides + bundled defaults). */

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}

export function urlMatches(pattern, url) {
  try {
    return globToRegExp(pattern).test(url);
  } catch {
    return false;
  }
}

export async function loadBundledProfiles() {
  const url = chrome.runtime.getURL("profiles/default-sites.json");
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export async function getAllProfiles() {
  const bundled = await loadBundledProfiles();
  const { siteProfiles } = await chrome.storage.local.get("siteProfiles");
  const user = Array.isArray(siteProfiles) ? siteProfiles : [];
  // User profiles first (override by id)
  const byId = new Map();
  for (const p of bundled) byId.set(p.id, p);
  for (const p of user) {
    if (p && p.id) byId.set(p.id, p);
  }
  // Keep user-only extras too
  return [...byId.values()];
}

export async function findProfileForUrl(url) {
  const profiles = await getAllProfiles();
  for (const p of profiles) {
    const matches = p.match || [];
    if (matches.some((m) => urlMatches(m, url))) return p;
  }
  return null;
}
