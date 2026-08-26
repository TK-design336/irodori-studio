import { useState } from "react";
import type { AudioFx } from "../types";
import { audioFxActive, audioFxOf, defaultAudioFx } from "../types";
import { highpassHz } from "../lib/audioFx";

type Patch = {
  volume?: number;
  speed?: number;
  audioFx?: AudioFx;
};

type Props = {
  volume: number;
  speed: number;
  audioFx?: AudioFx | null;
  onChange: (patch: Patch) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onApplyAll?: () => void;
  onApplySameSpeaker?: () => void;
  disabled?: boolean;
};

function SliderField({
  label,
  hint,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  return (
    <label className="param-field">
      <span className="param-label">{label}</span>
      {hint && <span className="param-hint">{hint}</span>}
      <div className="param-controls">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="icon-btn"
          disabled={disabled}
          onClick={() => onReset()}
        >
          ↺
        </button>
      </div>
    </label>
  );
}

export function AudioAdjustmentPanel({
  volume,
  speed,
  audioFx,
  onChange,
  collapsed,
  onToggle,
  onApplyAll,
  onApplySameSpeaker,
  disabled,
}: Props) {
  const [fxOpen, setFxOpen] = useState(false);
  const fx = audioFxOf({ audioFx });
  const fxOn = audioFxActive(fx);
  const hpLabel =
    fx.highpass <= 0.001
      ? "低周波除去 (オフ)"
      : `低周波除去 (${Math.round(highpassHz(fx.highpass))} Hz)`;

  const setFx = (key: keyof AudioFx, value: number) => {
    const n = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    onChange({ audioFx: { ...fx, [key]: n } });
  };

  return (
    <section className={`panel audio-panel${collapsed ? " collapsed" : ""}`}>
      <header className="panel-header" onClick={onToggle}>
        <h3>Audio Adjustment</h3>
        {onToggle && <span className="chevron">{collapsed ? "▸" : "▾"}</span>}
      </header>
      {!collapsed && (
        <div className="panel-body">
          <SliderField
            label={`音量 (${volume.toFixed(2)})`}
            min={0}
            max={2}
            step={0.01}
            value={volume}
            disabled={disabled}
            onChange={(v) => onChange({ volume: v })}
            onReset={() => onChange({ volume: 1 })}
          />
          <SliderField
            label={`速度 (${speed.toFixed(2)})`}
            min={0.5}
            max={2}
            step={0.01}
            value={speed}
            disabled={disabled}
            onChange={(v) => onChange({ speed: v })}
            onReset={() => onChange({ speed: 1 })}
          />
          <div className={`audio-fx-section${fxOpen ? " open" : ""}`}>
            <button
              type="button"
              className="audio-fx-toggle"
              onClick={() => setFxOpen((v) => !v)}
            >
              <span>
                追加調整
                {fxOn ? " · 変更あり" : ""}
              </span>
              <span className="chevron">{fxOpen ? "▾" : "▸"}</span>
            </button>
            {fxOpen && (
              <div className="audio-fx-body">
                <SliderField
                  label={hpLabel}
                  hint="ブーン、近接感などの低い音を切る"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.highpass}
                  disabled={disabled}
                  onChange={(v) => setFx("highpass", v)}
                  onReset={() => setFx("highpass", 0)}
                />
                <SliderField
                  label={`こもり除去 (${fx.muffle.toFixed(2)})`}
                  hint="箱に入ったような濁りを減らす"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.muffle}
                  disabled={disabled}
                  onChange={(v) => setFx("muffle", v)}
                  onReset={() => setFx("muffle", 0)}
                />
                <SliderField
                  label={`明瞭度 (${fx.clarity.toFixed(2)})`}
                  hint="子音や言葉の立ちを上げる"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.clarity}
                  disabled={disabled}
                  onChange={(v) => setFx("clarity", v)}
                  onReset={() => setFx("clarity", 0)}
                />
                <SliderField
                  label={`高域の抜け (${fx.air.toFixed(2)})`}
                  hint="息の細さやキラつきを足す"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.air}
                  disabled={disabled}
                  onChange={(v) => setFx("air", v)}
                  onReset={() => setFx("air", 0)}
                />
                <SliderField
                  label={`音量の平坦化 (${fx.flatten.toFixed(2)})`}
                  hint="大きい音と小さい音の差を縮める"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.flatten}
                  disabled={disabled}
                  onChange={(v) => setFx("flatten", v)}
                  onReset={() => setFx("flatten", 0)}
                />
                <SliderField
                  label={`サ行の刺さり抑制 (${fx.deesser.toFixed(2)})`}
                  hint="「ス」「シ」などの歯擦音。デエッサー"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.deesser}
                  disabled={disabled}
                  onChange={(v) => setFx("deesser", v)}
                  onReset={() => setFx("deesser", 0)}
                />
                <SliderField
                  label={`定常ノイズ除去 (${fx.denoise.toFixed(2)})`}
                  hint="一定して乗っているサー音・ヒス"
                  min={0}
                  max={1}
                  step={0.01}
                  value={fx.denoise}
                  disabled={disabled}
                  onChange={(v) => setFx("denoise", v)}
                  onReset={() => setFx("denoise", 0)}
                />
                <button
                  type="button"
                  className="audio-fx-reset"
                  disabled={disabled || !fxOn}
                  onClick={() => onChange({ audioFx: defaultAudioFx() })}
                >
                  追加調整をリセット
                </button>
                <p className="hint">
                  ノイズ除去以外は再生中に即反映。ノイズ除去は少し遅れて反映します
                </p>
              </div>
            )}
          </div>
          <div className="apply-actions">
            <button type="button" disabled={disabled} onClick={onApplyAll}>
              全行に一括適用
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onApplySameSpeaker}
            >
              同一話者行に一括適用
            </button>
          </div>
          <p className="hint">
            再生中は仮反映。保存時に焼き込みます
          </p>
        </div>
      )}
    </section>
  );
}
