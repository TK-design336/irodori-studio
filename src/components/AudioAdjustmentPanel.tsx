type Props = {
  volume: number;
  speed: number;
  onChange: (patch: { volume?: number; speed?: number }) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onApplyAll?: () => void;
  onApplySameSpeaker?: () => void;
  disabled?: boolean;
};

export function AudioAdjustmentPanel({
  volume,
  speed,
  onChange,
  collapsed,
  onToggle,
  onApplyAll,
  onApplySameSpeaker,
  disabled,
}: Props) {
  return (
    <section className={`panel audio-panel${collapsed ? " collapsed" : ""}`}>
      <header className="panel-header" onClick={onToggle}>
        <h3>Audio Adjustment</h3>
        {onToggle && <span className="chevron">{collapsed ? "▸" : "▾"}</span>}
      </header>
      {!collapsed && (
        <div className="panel-body">
          <label className="param-field">
            <span className="param-label">Volume ({volume.toFixed(2)})</span>
            <div className="param-controls">
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={volume}
                disabled={disabled}
                onChange={(e) => onChange({ volume: Number(e.target.value) })}
              />
              <input
                type="number"
                min={0}
                max={2}
                step={0.01}
                value={volume}
                disabled={disabled}
                onChange={(e) => onChange({ volume: Number(e.target.value) })}
              />
              <button
                type="button"
                className="icon-btn"
                disabled={disabled}
                onClick={() => onChange({ volume: 1 })}
              >
                ↺
              </button>
            </div>
          </label>
          <label className="param-field">
            <span className="param-label">Speed ({speed.toFixed(2)})</span>
            <div className="param-controls">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.01}
                value={speed}
                disabled={disabled}
                onChange={(e) => onChange({ speed: Number(e.target.value) })}
              />
              <input
                type="number"
                min={0.5}
                max={2}
                step={0.01}
                value={speed}
                disabled={disabled}
                onChange={(e) => onChange({ speed: Number(e.target.value) })}
              />
              <button
                type="button"
                className="icon-btn"
                disabled={disabled}
                onClick={() => onChange({ speed: 1 })}
              >
                ↺
              </button>
            </div>
          </label>
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
            再生中は仮反映。保存時に Volume / Speed（ピッチ維持）を焼き込みます
          </p>
        </div>
      )}
    </section>
  );
}
