const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;

const WORKLET_SOURCE = `
class IrodoriLiveMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${TARGET_SAMPLE_RATE};
    this.pending = [];
    this.position = 0;
    this.frame = new Int16Array(${FRAME_SAMPLES});
    this.frameOffset = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    for (let index = 0; index < input.length; index += 1) this.pending.push(input[index]);
    while (this.position + 1 < this.pending.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const sample = this.pending[left] * (1 - fraction) + this.pending[left + 1] * fraction;
      const bounded = Math.max(-1, Math.min(1, sample));
      this.frame[this.frameOffset] = bounded < 0 ? bounded * 32768 : bounded * 32767;
      this.frameOffset += 1;
      this.levelSquareSum += bounded * bounded;
      this.levelSampleCount += 1;
      if (this.frameOffset === this.frame.length) {
        const payload = this.frame.buffer;
        this.port.postMessage({ type: "pcm", payload }, [payload]);
        this.frame = new Int16Array(${FRAME_SAMPLES});
        this.frameOffset = 0;
      }
      this.position += this.ratio;
    }
    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.pending.splice(0, consumed);
      this.position -= consumed;
    }
    if (this.levelSampleCount >= 800) {
      this.port.postMessage({ type: "level", value: Math.sqrt(this.levelSquareSum / this.levelSampleCount) });
      this.levelSquareSum = 0;
      this.levelSampleCount = 0;
    }
    return true;
  }
}
registerProcessor("irodori-live-mic-capture", IrodoriLiveMicCapture);
`;

export type LiveMicCapture = {
  stop: () => Promise<void>;
};

export async function startLiveMicCapture(opts: {
  deviceId?: string;
  onPcm: (frame: Int16Array) => void;
  onLevel?: (level: number) => void;
}): Promise<LiveMicCapture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("この環境ではマイク入力に対応していません");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass || !window.AudioWorkletNode) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("この環境ではリアルタイム音声入力に対応していません");
  }

  const context = new AudioContextClass({ latencyHint: "interactive" });
  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
  );
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    URL.revokeObjectURL(workletUrl);
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "irodori-live-mic-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;

  worklet.port.onmessage = ({ data }) => {
    if (data?.type === "pcm" && data.payload instanceof ArrayBuffer) {
      opts.onPcm(new Int16Array(data.payload));
    }
    if (data?.type === "level" && opts.onLevel) {
      opts.onLevel(Math.min(1, Number(data.value) * 5));
    }
  };

  source.connect(worklet).connect(silentOutput).connect(context.destination);
  await context.resume();

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      worklet.port.onmessage = null;
      source.disconnect();
      worklet.disconnect();
      silentOutput.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      URL.revokeObjectURL(workletUrl);
      await context.close();
    },
  };
}

export const LIVE_MIC_SAMPLE_RATE = TARGET_SAMPLE_RATE;

export function normalizeMicInputs(devices: MediaDeviceInfo[] = []): Array<{
  deviceId: string;
  label: string;
}> {
  const outputs = [{ deviceId: "", label: "システム既定" }];
  const seen = new Set<string>([""]);
  for (const device of devices) {
    if (device.kind !== "audioinput" || !device.deviceId || seen.has(device.deviceId)) {
      continue;
    }
    seen.add(device.deviceId);
    outputs.push({
      deviceId: device.deviceId,
      label: device.label?.trim() || `マイク ${outputs.length}`,
    });
  }
  return outputs;
}
