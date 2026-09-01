import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, SamplingParams, SpeakerInfo } from "../types";
import { DEFAULT_CFG_SCALE_CAPTION, isIrodoriV4 } from "../types";
import { prepareLineSynthText } from "./synthText";
import { PRESET_PUNCTUATION, splitText } from "./splitText";

const LIVE_PROJECT = "__live__";

function speakerOf(
  speakers: SpeakerInfo[],
  embedPath: string,
): SpeakerInfo | undefined {
  return speakers.find((s) => s.embedPath === embedPath);
}

function usesStyleCaption(speaker: SpeakerInfo | null | undefined): boolean {
  const k = speaker?.kind;
  return k === "ref" || k === "trained" || k === "blend";
}

export function liveMaxChars(settings: AppSettings): number {
  const v = settings.httpMaxChars;
  return typeof v === "number" && v > 0 ? v : 80;
}

export function liveTextSegments(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parts = splitText(trimmed, [...PRESET_PUNCTUATION], "pack", maxChars);
  return parts.length > 0 ? parts : [trimmed];
}

function buildSynthArgs(
  synthText: string,
  outPath: string,
  sp: SpeakerInfo,
  sampling: SamplingParams,
  settings: AppSettings,
  caption: string,
): Record<string, unknown> {
  const cfgScaleCaption = DEFAULT_CFG_SCALE_CAPTION;
  const synthArgs: Record<string, unknown> = {
    text: synthText,
    outputWav: outPath,
    numSteps: sampling.numSteps,
    numCandidates: 1,
    seed: sampling.seed,
    seconds: sampling.seconds,
    durationScale: sampling.durationScale,
    tScheduleMode: sampling.tScheduleMode,
    swayCoeff: sampling.swayCoeff,
    cfgGuidanceMode: sampling.cfgGuidanceMode,
    cfgScaleText: sampling.cfgScaleText,
    cfgScaleSpeaker: sampling.cfgScaleSpeaker,
  };

  if (sp.kind === "ref") {
    const wavs = sp.refWavs?.filter(Boolean);
    if (wavs && wavs.length > 0) {
      synthArgs.refWavs = wavs;
      synthArgs.refWav = wavs[0];
    } else if (sp.refWav) {
      synthArgs.refWav = sp.refWav;
    } else {
      throw new Error("参照音源が未設定の話者です");
    }
  } else if (sp.kind === "caption") {
    if (!sp.caption?.trim()) {
      throw new Error("キャプションが未設定の話者です");
    }
    synthArgs.caption = sp.caption;
    synthArgs.noRef = true;
    synthArgs.cfgScaleCaption = cfgScaleCaption;
  } else {
    synthArgs.refEmbed = sp.embedPath;
  }

  if (
    isIrodoriV4(settings) &&
    sp.kind !== "caption" &&
    usesStyleCaption(sp) &&
    caption.trim()
  ) {
    synthArgs.caption = caption.trim();
    synthArgs.cfgScaleCaption = cfgScaleCaption;
  }

  return synthArgs;
}

export async function synthesizeLiveSegment(opts: {
  text: string;
  itemId: string;
  segmentIndex: number;
  speakerEmbedPath: string;
  speakers: SpeakerInfo[];
  sampling: SamplingParams;
  settings: AppSettings;
  caption: string;
  speed: number;
  isActive: () => boolean;
}): Promise<string> {
  const sp = speakerOf(opts.speakers, opts.speakerEmbedPath);
  if (!sp) throw new Error("話者が見つかりません");

  if (!opts.isActive()) throw new Error("cancelled");

  const synthText = await prepareLineSynthText(opts.text);
  if (!opts.isActive()) throw new Error("cancelled");

  const outPath = await invoke<string>("line_cache_wav_path", {
    projectName: LIVE_PROJECT,
    lineId: opts.itemId,
    variantId: opts.segmentIndex > 0 ? `seg-${opts.segmentIndex}` : null,
  });

  const synthArgs = buildSynthArgs(
    synthText,
    outPath,
    sp,
    opts.sampling,
    opts.settings,
    opts.caption,
  );

  await invoke("synthesize_line", { args: synthArgs });
  if (!opts.isActive()) throw new Error("cancelled");

  const exists = await invoke<boolean>("file_exists", { path: outPath });
  if (!exists) throw new Error("生成失敗: 出力ファイルがありません");

  const playPath = await invoke<string>("prepare_playback_wav", {
    src: outPath,
    speed: Math.min(2, Math.max(0.5, opts.speed)),
    denoise: 0,
    clipEdit: null,
  });

  if (playPath !== outPath) {
    try {
      await invoke("delete_file", { path: outPath });
    } catch {
      /* ignore */
    }
  }

  return playPath;
}

export async function runLiveSegmentPipeline<T>(opts: {
  segmentCount: number;
  produce: (index: number) => Promise<T>;
  consume: (result: T, index: number) => Promise<void>;
}): Promise<T[]> {
  const deferredResults = Array.from({ length: opts.segmentCount }, () => {
    let resolve!: (value: { result?: T; error?: unknown }) => void;
    const promise = new Promise<{ result?: T; error?: unknown }>((accept) => {
      resolve = accept;
    });
    return { promise, resolve };
  });

  const generationTask = (async () => {
    const produced: T[] = [];
    try {
      for (let index = 0; index < opts.segmentCount; index += 1) {
        const result = await opts.produce(index);
        produced.push(result);
        deferredResults[index].resolve({ result });
      }
      return produced;
    } catch (error) {
      for (let index = produced.length; index < deferredResults.length; index += 1) {
        deferredResults[index].resolve({ error });
      }
      throw error;
    }
  })();

  const playbackTask = (async () => {
    for (let index = 0; index < deferredResults.length; index += 1) {
      const { result, error } = await deferredResults[index].promise;
      if (error) throw error;
      await opts.consume(result as T, index);
    }
  })();

  const [generationOutcome, playbackOutcome] = await Promise.allSettled([
    generationTask,
    playbackTask,
  ]);
  if (generationOutcome.status === "rejected") throw generationOutcome.reason;
  if (playbackOutcome.status === "rejected") throw playbackOutcome.reason;
  return generationOutcome.value;
}
