export const AUDIO_OUTPUT_STORAGE_KEY = "irodori-studio-audio-output-v2";

export const DEFAULT_AUDIO_OUTPUT = {
  deviceId: "",
  label: "システム既定",
};

export type AudioOutputPreference = {
  deviceId: string;
  label: string;
  configured: boolean;
};

export function parseAudioOutputPreference(raw: string | null): AudioOutputPreference {
  if (!raw) return { ...DEFAULT_AUDIO_OUTPUT, configured: false };
  try {
    const parsed = JSON.parse(raw) as { deviceId?: unknown; label?: unknown };
    if (typeof parsed?.deviceId !== "string") {
      return { ...DEFAULT_AUDIO_OUTPUT, configured: false };
    }
    return {
      deviceId: parsed.deviceId,
      label:
        typeof parsed.label === "string" && parsed.label.trim()
          ? parsed.label.trim()
          : parsed.deviceId
            ? "選択した音声出力"
            : DEFAULT_AUDIO_OUTPUT.label,
      configured: true,
    };
  } catch {
    return { ...DEFAULT_AUDIO_OUTPUT, configured: false };
  }
}

export function loadAudioOutputPreference(): AudioOutputPreference {
  try {
    return parseAudioOutputPreference(localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_AUDIO_OUTPUT, configured: false };
  }
}

export function saveAudioOutputPreference(pref: Pick<AudioOutputPreference, "deviceId" | "label">): void {
  localStorage.setItem(
    AUDIO_OUTPUT_STORAGE_KEY,
    JSON.stringify({ deviceId: pref.deviceId, label: pref.label }),
  );
}

export function normalizeAudioOutputs(
  devices: MediaDeviceInfo[] = [],
  selectedDevice: MediaDeviceInfo | null = null,
): Array<{ deviceId: string; label: string }> {
  const outputs = [{ ...DEFAULT_AUDIO_OUTPUT }];
  const seen = new Set(["", "default"]);
  for (const device of [...devices, selectedDevice].filter(
    (d): d is MediaDeviceInfo => d != null,
  )) {
    if (device.kind !== "audiooutput" || !device.deviceId || seen.has(device.deviceId)) {
      continue;
    }
    seen.add(device.deviceId);
    outputs.push({
      deviceId: device.deviceId,
      label: device.label?.trim() || `音声出力 ${outputs.length}`,
    });
  }
  return outputs;
}

export type NativeOutputDeviceInfo = {
  id: string;
  host: string;
  display_name: string;
};

export function normalizeNativeAudioOutputs(
  devices: NativeOutputDeviceInfo[] = [],
): Array<{ deviceId: string; label: string }> {
  const outputs = [{ ...DEFAULT_AUDIO_OUTPUT }];
  const seen = new Set(["", "default"]);
  for (const device of devices) {
    if (!device.id) continue;
    const deviceId = `${device.host}::${device.id}`;
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);
    outputs.push({
      deviceId,
      label: device.display_name?.trim() || `音声出力 ${outputs.length}`,
    });
  }
  return outputs;
}

export type AudioOutputStatus =
  | "ready"
  | "requesting"
  | "switching"
  | "unsupported"
  | "locked-default";

export function audioOutputSinkSupported(): boolean {
  if (typeof AudioContext === "undefined") return false;
  try {
    const probe = new AudioContext();
    const ok = typeof (probe as AudioContext & { setSinkId?: unknown }).setSinkId === "function";
    void probe.close();
    return ok;
  } catch {
    return false;
  }
}
