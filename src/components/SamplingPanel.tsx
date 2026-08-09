import type { SamplingParams } from "../types";
import { defaultSampling } from "../types";
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
              "Num Steps": d.numSteps,
              "Num Candidates": d.numCandidates,
              "Duration Scale": d.durationScale,
              "Sway Coeff": d.swayCoeff,
              "CFG Scale Text": d.cfgScaleText,
              "CFG Scale Speaker": d.cfgScaleSpeaker,
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
              label="Num Steps"
              min={1}
              max={120}
              step={1}
              value={value.numSteps}
              onChange={(numSteps) => onChange({ ...value, numSteps })}
            />
            <SliderField
              label="Num Candidates"
              min={1}
              max={32}
              step={1}
              value={value.numCandidates}
              onChange={(numCandidates) => onChange({ ...value, numCandidates })}
            />
            <label className="param-field">
              <span className="param-label">Seed (blank=random)</span>
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
              <span className="param-label">Seconds (blank=auto)</span>
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
              label="Duration Scale"
              min={0.5}
              max={1.5}
              step={0.01}
              value={value.durationScale}
              onChange={(durationScale) => onChange({ ...value, durationScale })}
            />
            <label className="param-field">
              <span className="param-label">Time Schedule</span>
              <BoundedSelect
                value={value.tScheduleMode}
                options={[
                  { value: "linear", label: "linear" },
                  { value: "sway", label: "sway" },
                ]}
                onChange={(tScheduleMode) =>
                  onChange({ ...value, tScheduleMode })
                }
                aria-label="Time Schedule"
              />
            </label>
            <SliderField
              label="Sway Coeff"
              min={-1}
              max={1.5}
              step={0.01}
              value={value.swayCoeff}
              disabled={swayDisabled}
              onChange={(swayCoeff) => onChange({ ...value, swayCoeff })}
            />
            <label className="param-field">
              <span className="param-label">CFG Guidance Mode</span>
              <BoundedSelect
                value={value.cfgGuidanceMode}
                options={[
                  { value: "independent", label: "independent" },
                  { value: "joint", label: "joint" },
                  { value: "alternating", label: "alternating" },
                ]}
                onChange={(cfgGuidanceMode) =>
                  onChange({ ...value, cfgGuidanceMode })
                }
                aria-label="CFG Guidance Mode"
              />
            </label>
            <SliderField
              label="CFG Scale Text"
              min={0}
              max={10}
              step={0.1}
              value={value.cfgScaleText}
              onChange={(cfgScaleText) => onChange({ ...value, cfgScaleText })}
            />
            <SliderField
              label="CFG Scale Speaker"
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
