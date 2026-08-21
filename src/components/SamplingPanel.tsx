import type { SamplingParams } from "../types";
import { defaultSampling, clampCandidateCount } from "../types";
import { BoundedSelect } from "./BoundedSelect";

type Props = {
  value: SamplingParams;
  onChange: (next: SamplingParams) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onApplyAll?: () => void;
  onApplySameSpeaker?: () => void;
};

function SliderField({
  label,
  min,
  max,
  step,
  value,
  onChange,
  disabled,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="param-field">
      <span className="param-label">{label}</span>
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
          title="Reset"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            const d = defaultSampling();
            const map: Record<string, number> = {
              ステップ数: d.numSteps,
              生成数: d.numCandidates,
              長さ倍率: d.durationScale,
              Sway係数: d.swayCoeff,
              テキスト強度: d.cfgScaleText,
              話者強度: d.cfgScaleSpeaker,
            };
            if (label in map) onChange(map[label]);
          }}
        >
          ↺
        </button>
      </div>
    </label>
  );
}

export function SamplingPanel({
  value,
  onChange,
  collapsed,
  onToggle,
  onApplyAll,
  onApplySameSpeaker,
}: Props) {
  const swayDisabled = value.tScheduleMode !== "sway";

  return (
    <section
      className={`panel sampling-panel${collapsed ? " collapsed" : ""}`}
    >
      <header className="panel-header" onClick={onToggle}>
        <h3>Sampling</h3>
        {onToggle && <span className="chevron">{collapsed ? "▸" : "▾"}</span>}
      </header>
      {!collapsed && (
        <div className="panel-body">
          <div className="param-grid">
            <SliderField
              label="ステップ数"
              min={1}
              max={120}
              step={1}
              value={value.numSteps}
              onChange={(numSteps) => onChange({ ...value, numSteps })}
            />
            <SliderField
              label="生成数"
              min={1}
              max={10}
              step={1}
              value={clampCandidateCount(value.numCandidates)}
              onChange={(numCandidates) =>
                onChange({
                  ...value,
                  numCandidates: clampCandidateCount(numCandidates),
                })
              }
            />
            <label className="param-field">
              <span className="param-label">複数生成方式</span>
              <BoundedSelect
                value={
                  value.multiGenerateMode === "individual"
                    ? "individual"
                    : "candidates"
                }
                options={[
                  { value: "candidates", label: "Num Candidate" },
                  { value: "individual", label: "個別生成" },
                ]}
                onChange={(multiGenerateMode) =>
                  onChange({
                    ...value,
                    multiGenerateMode:
                      multiGenerateMode === "individual"
                        ? "individual"
                        : "candidates",
                  })
                }
                aria-label="複数生成方式"
              />
            </label>
            <label className="param-field">
              <span className="param-label">シード（空欄でランダム）</span>
              <input
                type="text"
                value={value.seed ?? ""}
                placeholder=""
                onChange={(e) => {
                  const t = e.target.value.trim();
                  onChange({
                    ...value,
                    seed: t === "" ? null : Number(t),
                  });
                }}
              />
            </label>
            <label className="param-field">
              <span className="param-label">長さ（秒・空欄で自動）</span>
              <input
                type="text"
                value={value.seconds ?? ""}
                placeholder=""
                onChange={(e) => {
                  const t = e.target.value.trim();
                  onChange({
                    ...value,
                    seconds: t === "" ? null : Number(t),
                  });
                }}
              />
            </label>
            <SliderField
              label="長さ倍率"
              min={0.5}
              max={1.5}
              step={0.01}
              value={value.durationScale}
              onChange={(durationScale) => onChange({ ...value, durationScale })}
            />
            <label className="param-field">
              <span className="param-label">時間スケジュール</span>
              <BoundedSelect
                value={value.tScheduleMode}
                options={[
                  { value: "linear", label: "線形" },
                  { value: "sway", label: "Sway" },
                ]}
                onChange={(tScheduleMode) =>
                  onChange({ ...value, tScheduleMode })
                }
                aria-label="時間スケジュール"
              />
            </label>
            <SliderField
              label="Sway係数"
              min={-1}
              max={1.5}
              step={0.01}
              value={value.swayCoeff}
              disabled={swayDisabled}
              onChange={(swayCoeff) => onChange({ ...value, swayCoeff })}
            />
            <label className="param-field">
              <span className="param-label">CFG方式</span>
              <BoundedSelect
                value={value.cfgGuidanceMode}
                options={[
                  { value: "independent", label: "独立" },
                  { value: "joint", label: "一括" },
                  { value: "alternating", label: "交互" },
                ]}
                onChange={(cfgGuidanceMode) =>
                  onChange({ ...value, cfgGuidanceMode })
                }
                aria-label="CFG方式"
              />
            </label>
            <SliderField
              label="テキスト強度"
              min={0}
              max={10}
              step={0.1}
              value={value.cfgScaleText}
              onChange={(cfgScaleText) => onChange({ ...value, cfgScaleText })}
            />
            <SliderField
              label="話者強度"
              min={0}
              max={10}
              step={0.1}
              value={value.cfgScaleSpeaker}
              onChange={(cfgScaleSpeaker) =>
                onChange({ ...value, cfgScaleSpeaker })
              }
            />
          </div>

          <div className="apply-actions">
            <button type="button" onClick={onApplyAll}>
              全行に一括適用
            </button>
            <button type="button" onClick={onApplySameSpeaker}>
              同一話者行に一括適用
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
