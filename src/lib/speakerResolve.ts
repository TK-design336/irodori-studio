import type { Project, ProjectLine, SpeakerInfo } from "../types";

function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Stable key within the outputs tree (independent of outputs-root prefix). */
export function speakerEmbedKey(embedPath: string): string | null {
  const norm = embedPath.replace(/\\/g, "/");
  let m = norm.match(/\/_profiles\/([^/]+)\.json$/i);
  if (m) return `profile:${m[1].toLowerCase()}`;
  m = norm.match(/\/_blends\/([^/]+)\.speaker\.safetensors$/i);
  if (m) return `blend:${m[1].toLowerCase()}`;
  m = norm.match(/\/([^/]+)\/checkpoint_final\.speaker\.safetensors$/i);
  if (m) return `trained:${m[1].toLowerCase()}`;
  return null;
}

function looksLikePath(s: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\)/.test(s) || /[\\/]/.test(s);
}

/** old embedPath → current path/name after in-app rename */
const speakerRenameMap = new Map<string, { embedPath: string; name: string }>();

export function noteSpeakerRename(
  oldEmbedPath: string,
  next: { embedPath: string; name: string },
) {
  if (!oldEmbedPath || !next.embedPath) return;
  const keys = [oldEmbedPath, normPath(oldEmbedPath)];
  for (const key of keys) speakerRenameMap.set(key, next);
  for (const [key, mapped] of speakerRenameMap) {
    if (
      mapped.embedPath === oldEmbedPath ||
      normPath(mapped.embedPath) === normPath(oldEmbedPath)
    ) {
      speakerRenameMap.set(key, next);
    }
  }
}

/** Map a stored line speaker to the current scanned speaker list. */
export function reconcileLineSpeaker(
  line: Pick<ProjectLine, "speakerEmbedPath" | "speakerName">,
  speakers: SpeakerInfo[],
): Pick<ProjectLine, "speakerEmbedPath" | "speakerName"> {
  const { speakerEmbedPath, speakerName } = line;
  if (speakers.length === 0) {
    return { speakerEmbedPath, speakerName };
  }

  const renamed =
    speakerRenameMap.get(speakerEmbedPath) ??
    speakerRenameMap.get(normPath(speakerEmbedPath));
  if (renamed) {
    const still = speakers.find(
      (s) =>
        s.embedPath === renamed.embedPath ||
        normPath(s.embedPath) === normPath(renamed.embedPath),
    );
    if (still) {
      return { speakerEmbedPath: still.embedPath, speakerName: still.name };
    }
  }

  const exact = speakers.find((s) => s.embedPath === speakerEmbedPath);
  if (exact) {
    return { speakerEmbedPath: exact.embedPath, speakerName: exact.name };
  }

  if (speakerEmbedPath) {
    const n = normPath(speakerEmbedPath);
    const byNorm = speakers.find((s) => normPath(s.embedPath) === n);
    if (byNorm) {
      return { speakerEmbedPath: byNorm.embedPath, speakerName: byNorm.name };
    }
  }

  const name = speakerName.trim();
  if (name && !looksLikePath(name)) {
    const byName = speakers.find((s) => s.name === name);
    if (byName) {
      return { speakerEmbedPath: byName.embedPath, speakerName: byName.name };
    }
  }

  if (speakerEmbedPath) {
    const key = speakerEmbedKey(speakerEmbedPath);
    if (key) {
      const byKey = speakers.find((s) => speakerEmbedKey(s.embedPath) === key);
      if (byKey) {
        return { speakerEmbedPath: byKey.embedPath, speakerName: byKey.name };
      }
    }
  }

  return {
    speakerEmbedPath,
    speakerName: name && !looksLikePath(name) ? name : speakerName,
  };
}

export function reconcileProjectSpeakers(
  project: Project,
  speakers: SpeakerInfo[],
): Project {
  if (speakers.length === 0) return project;
  let changed = false;
  const lines = project.lines.map((line) => {
    const next = reconcileLineSpeaker(line, speakers);
    if (
      next.speakerEmbedPath !== line.speakerEmbedPath ||
      next.speakerName !== line.speakerName
    ) {
      changed = true;
      return { ...line, ...next };
    }
    return line;
  });
  return changed ? { ...project, lines } : project;
}
