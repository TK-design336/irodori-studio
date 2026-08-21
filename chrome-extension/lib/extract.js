/** Thin helper: extract page via scripting (used conceptually by sidepanel). */
export async function extractActiveTab(tab, profile) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["vendor/Readability.js", "content/fetchers.js", "content/extract-page.js"],
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (p) => globalThis.__irodoriExtract({ profile: p }),
    args: [profile],
  });
  return result;
}
