import { invoke } from "@tauri-apps/api/core";
import type { AppliedReading } from "./annotations";
import {
  buildSynthText,
  synthTextForLine,
  validateReadings,
} from "./annotations";
import type { ProjectLine } from "../types";

/** Bumped when replace/reading dicts change so stale auto-readings are not reused. */
let prepareEpoch = 0;
/** key: `${lineId}\0${signature}` → prepared TTS text */
const preparedSynthCache = new Map<string, string>();

export function bumpPreparedSynthEpoch(): void {
  prepareEpoch += 1;
}

export function clearPreparedSynthCache(): void {
  preparedSynthCache.clear();
}

export function linePrepareSignature(
  line: Pick<ProjectLine, "text" | "readings">,
): string {
  const manual = validateReadings(line.text, line.readings ?? []);
  const readingKey = manual
    .map((r) => `${r.kind}:${r.start}:${r.end}:${r.surface}:${r.reading}`)
    .join("\n");
  return `${prepareEpoch}\0${line.text}\0${readingKey}`;
}

function cacheKey(lineId: string, sig: string): string {
  return `${lineId}\0${sig}`;
}

export function rememberPreparedSynth(
  line: Pick<ProjectLine, "id" | "text" | "readings">,
  text: string,
): void {
  const sig = linePrepareSignature(line);
  preparedSynthCache.set(cacheKey(line.id, sig), text);
}

export function hasFreshPreparedSynth(
  line: Pick<ProjectLine, "id" | "text" | "readings">,
): boolean {
  const sig = linePrepareSignature(line);
  return preparedSynthCache.has(cacheKey(line.id, sig));
}

/**
 * Text that would be sent to TTS now.
 * Uses cached `prepare_synth_text` (auto readings + dict replace) when fresh;
 * otherwise manual readings only (sync fallback).
 */
export function currentLineSynthText(line: ProjectLine): string {
  const sig = linePrepareSignature(line);
  const hit = preparedSynthCache.get(cacheKey(line.id, sig));
  if (hit != null) return hit;
  return lineSynthTextSync(line);
}

/** Manual readings + background auto layer (Rust/Python). */
export async function prepareLineSynthText(
  text: string,
  readings?: AppliedReading[],
): Promise<string> {
  const manual = validateReadings(text, readings ?? []);
  try {
    return await invoke<string>("prepare_synth_text_cmd", {
      text,
      manualReadings: manual,
    });
  } catch {
    return synthTextForLine(text, manual);
  }
}

export function lineSynthTextSync(line: ProjectLine): string {
  return synthTextForLine(line.text, line.readings);
}

export async function lineSynthText(line: ProjectLine): Promise<string> {
  const sig = linePrepareSignature(line);
  const text = await prepareLineSynthText(line.text, line.readings);
  preparedSynthCache.set(cacheKey(line.id, sig), text);
  return text;
}

export function mergeAutoReadings(
  text: string,
  manual: AppliedReading[],
  auto: AppliedReading[],
): string {
  const blocked = manual.map((r) => ({ start: r.start, end: r.end }));
  const extra = auto.filter(
    (r) => !blocked.some((b) => r.start < b.end && b.start < r.end),
  );
  return buildSynthText(text, [...manual, ...extra]);
}
