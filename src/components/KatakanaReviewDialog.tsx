import { useMemo, useState } from "react";
import {
  applyKatakanaEdits,
  hitsToEdits,
  type KatakanaEdit,
  type KatakanaHit,
} from "../lib/katakanaApply";

export type KatakanaReviewItem = {
  lineId: string;
  text: string;
  hits: KatakanaHit[];
  /** 表示用（例: "3 行目"） */
  label: string;
};

type LineEdits = {
  lineId: string;
  text: string;
  label: string;
  edits: KatakanaEdit[];
};

type Props = {
  items: KatakanaReviewItem[];
  onApply: (updates: { lineId: string; text: string }[]) => void;
  onCancel: () => void;
};

export function KatakanaReviewDialog({ items, onApply, onCancel }: Props) {
  const [lines, setLines] = useState<LineEdits[]>(() =>
    items.map((it) => ({
      lineId: it.lineId,
      text: it.text,
      label: it.label,
      edits: hitsToEdits(it.hits),
    })),
  );

  const multi = lines.length > 1;
  const totalEdits = lines.reduce((s, l) => s + l.edits.length, 0);

  const previews = useMemo(
    () =>
      lines.map((l) => ({
        lineId: l.lineId,
        label: l.label,
        text: applyKatakanaEdits(l.text, l.edits),
      })),
    [lines],
  );

  const setAt = (
    lineIdx: number,
    editIdx: number,
    patch: Partial<KatakanaEdit>,
  ) => {
    setLines((prev) =>
      prev.map((l, li) =>
        li !== lineIdx
          ? l
          : {
              ...l,
              edits: l.edits.map((e, ei) =>
                ei === editIdx ? { ...e, ...patch } : e,
              ),
            },
      ),
    );
  };

  const acceptAllKnown = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        edits: l.edits.map((e) => ({
          ...e,
          accepted: e.editKana.trim().length > 0,
        })),
      })),
    );
  };

  const rejectAll = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        edits: l.edits.map((e) => ({ ...e, accepted: false })),
      })),
    );
  };

  const title =
    multi
      ? `カタカナ提案 — ${lines.length} 行`
      : `カタカナ提案${lines[0] ? ` — ${lines[0].label}` : ""}`;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal panel katakana-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-header">
          <h3>{title}</h3>
        </header>
        <div className="panel-body form-stack">
          {totalEdits === 0 ? (
            <p className="hint">英単語が見つかりませんでした</p>
          ) : (
            <>
              <div className="row">
                <button type="button" onClick={acceptAllKnown}>
                  一括承認
                </button>
                <button type="button" onClick={rejectAll}>
                  すべて却下
                </button>
              </div>
              <div className="katakana-list">
                {lines.map((l, li) => (
                  <div key={l.lineId} className="katakana-line-group">
                    {multi && (
                      <div className="katakana-line-label">{l.label}</div>
                    )}
                    {l.edits.map((e, i) => (
                      <div
                        key={`${l.lineId}-${e.start}-${e.word}-${i}`}
                        className="katakana-row"
                      >
                        <label className="katakana-check">
                          <input
                            type="checkbox"
                            checked={e.accepted}
                            onChange={(ev) =>
                              setAt(li, i, { accepted: ev.target.checked })
                            }
                          />
                          <span className="katakana-word">{e.word}</span>
                        </label>
                        <span className="katakana-arrow">→</span>
                        <input
                          className="katakana-kana"
                          value={e.editKana}
                          placeholder={
                            e.kana == null ? "手動入力…" : undefined
                          }
                          onChange={(ev) => {
                            const v = ev.target.value;
                            setAt(li, i, {
                              editKana: v,
                              accepted:
                                v.trim().length > 0 ? true : e.accepted,
                            });
                          }}
                        />
                        {e.kana == null && (
                          <span className="hint katakana-miss">辞書なし</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              {multi ? (
                <div className="katakana-preview-pane">
                  <span className="field-label">プレビュー</span>
                  <div className="katakana-previews">
                    {previews.map((p) => (
                      <label key={p.lineId}>
                        {p.label}
                        <textarea
                          className="katakana-preview"
                          value={p.text}
                          readOnly
                          rows={2}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="katakana-preview-pane">
                  <label>
                    プレビュー
                    <textarea
                      className="katakana-preview"
                      value={previews[0]?.text ?? ""}
                      readOnly
                      rows={4}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={totalEdits === 0}
              onClick={() =>
                onApply(
                  lines.map((l) => ({
                    lineId: l.lineId,
                    text: applyKatakanaEdits(l.text, l.edits),
                  })),
                )
              }
            >
              適用
            </button>
            <button type="button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
