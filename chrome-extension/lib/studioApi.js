/** Studio HTTP API helpers (storage-backed; no DOM). */

export const DEFAULT_BASE_URL = "http://127.0.0.1:18790";
export const ALL_PAGE_ORIGINS = ["http://*/*", "https://*/*"];

export function studioOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export async function loadStudioConfig() {
  const stored = await chrome.storage.local.get(["baseUrl", "token"]);
  return {
    baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ""),
    token: stored.token || "",
  };
}

export async function hasOriginPermission(origins) {
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
export async function ensureHostPermission(baseUrl) {
  const origin = studioOrigin(baseUrl);
  if (!origin) throw new Error("ベース URL が不正です");
  const pattern = origin + "/*";
  if (await hasOriginPermission([pattern])) return;
  if (await hasOriginPermission(ALL_PAGE_ORIGINS)) return;
  throw new Error(
    "Studio へのアクセス権限がありません。設定で「接続テスト」を押してください。",
  );
}

export async function ensureSiteAccess() {
  if (await hasOriginPermission(ALL_PAGE_ORIGINS)) return;
  throw new Error(
    "ページへのアクセス権限がありません。「このページを読み上げ」をもう一度押し、許可してください。",
  );
}

export function isMissingHostPermissionError(err) {
  return /must request permission|Cannot access contents/i.test(String(err?.message || err || ""));
}

export async function apiFetch(path, { method = "GET", body, expectBinary = false, config } = {}) {
  const { baseUrl, token } = config || (await loadStudioConfig());
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
