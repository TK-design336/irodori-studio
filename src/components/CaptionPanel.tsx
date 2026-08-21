import { DEFAULT_CFG_SCALE_CAPTION } from "../types";

type Props = {
  value: string;
  cfgScaleCaption: number;
  onChange: (patch: { caption?: string; cfgScaleCaption?: number }) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  onApplyAll?: () => void;
  onApplySameSpeaker?: () => void;
  disabled?: boolean;
};

export function CaptionPanel({
  value,
  cfgScaleCaption,
  onChange,
  collapsed,
  onToggle,
  onApplyAll,
  onApplySameSpeaker,
  disabled,
}: Props) {
  return (
    <section className={`panel caption-panel${collapsed ? " collapsed" : ""}`}>
      <header className="panel-header" onClick={onToggle}>
        <h3>Caption</h3>
        {onToggle && <span className="chevron">{collapsed ? "▸" : "▾"}</span>}
      </header>
      {!collapsed && (
        <div className="panel-body">
          <label className="param-field">
            <span className="param-label">スタイルキャプション</span>
            <textarea
              className="line-caption-input"
              value={value}
              disabled={disabled}
              placeholder="例: 泣きそうな声"
              rows={3}
              onChange={(e) => onChange({ caption: e.target.value })}
            />
          </label>
          <label className="param-field">
            <span className="param-label">
              キャプション強度 ({cfgScaleCaption.toFixed(2)})
            </span>
            <div className="param-controls">
              <input
                type="range"
                min={0}
                max={10}
                step={0.05}
                value={cfgScaleCaption}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ cfgScaleCaption: Number(e.target.value) })
                }
              />
              <input
                type="number"
                min={0}
                max={10}
                step={0.05}
                value={cfgScaleCaption}
                disabled={disabled}
                onChange={(e) =>
                  onChange({ cfgScaleCaption: Number(e.target.value) })
                }
              />
              <button
                type="button"
                className="icon-btn"
                title="Reset"
                disabled={disabled}
                onClick={() =>
                  onChange({ cfgScaleCaption: DEFAULT_CFG_SCALE_CAPTION })
                }
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
            参照音源に加えて、感情・話し方のキャプションを渡せます
          </p>
        </div>
      )}
    </section>
  );
}
