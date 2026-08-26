import type { AudioFx } from "../types";

/** Keep numeric targets in sync with `build_post_af` in src-tauri/src/lib.rs. */
export function highpassHz(amount: number): number {
  if (amount <= 0.001) return 20;
  return 40 + 110 * amount;
}

type FxNodes = {
  highpass: BiquadFilterNode;
  lowshelf: BiquadFilterNode;
  presence: BiquadFilterNode;
  highshelf: BiquadFilterNode;
  deess: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  makeup: GainNode;
};

export function applyAudioFxToNodes(nodes: FxNodes, fx: AudioFx): void {
  const hp = highpassHz(fx.highpass);
  nodes.highpass.type = "highpass";
  nodes.highpass.frequency.value = hp;
  nodes.highpass.Q.value = 0.707;

  nodes.lowshelf.type = "lowshelf";
  nodes.lowshelf.frequency.value = 320;
  nodes.lowshelf.gain.value = -8 * fx.muffle;
  nodes.lowshelf.Q.value = 0.7;

  nodes.presence.type = "peaking";
  nodes.presence.frequency.value = 3200;
  nodes.presence.gain.value = 6 * fx.clarity;
  nodes.presence.Q.value = 1.1;

  nodes.highshelf.type = "highshelf";
  nodes.highshelf.frequency.value = 9000;
  nodes.highshelf.gain.value = 5 * fx.air;
  nodes.highshelf.Q.value = 0.7;

  nodes.deess.type = "peaking";
  nodes.deess.frequency.value = 6500;
  nodes.deess.gain.value = -10 * fx.deesser;
  nodes.deess.Q.value = 2.2;

  const a = fx.flatten;
  if (a <= 0.001) {
    nodes.compressor.threshold.value = 0;
    nodes.compressor.knee.value = 0;
    nodes.compressor.ratio.value = 1;
    nodes.compressor.attack.value = 0.003;
    nodes.compressor.release.value = 0.1;
    nodes.makeup.gain.value = 1;
  } else {
    nodes.compressor.threshold.value = -6 - 18 * a;
    nodes.compressor.knee.value = 6;
    nodes.compressor.ratio.value = 1 + 11 * a;
    nodes.compressor.attack.value = 0.004;
    nodes.compressor.release.value = 0.12;
    const makeupDb = 8 * a * (0.45 + 0.55 * a);
    nodes.makeup.gain.value = 10 ** (makeupDb / 20);
  }
}
