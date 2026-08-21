import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  emptyDictionaries,
  emitDictionariesChanged,
  newDictId,
  type Dictionaries,
  type ReadingDictEntry,
} from "../lib/dictionaries";
import { ANNOTATION_KIND_LABEL, type AnnotationKind } from "../lib/annotations";
import type { ReplaceEntry } from "../lib/replaceApply";

const READING_KINDS: AnnotationKind[] = ["english", "heteronym", "numeric"];

export function DictionaryView() {
  const [dicts, setDicts] = useState<Dictionaries>(emptyDictionaries());
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [replaceCollapsed, setReplaceCollapsed] = useState(false);
  const [readingCollapsed, setReadingCollapsed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await invoke<Dictionaries>("get_dictionaries");
      const incoming = d ?? emptyDictionaries();
      setDicts({
        ...incoming,
        replace: incoming.replace ?? [],
        reading: (incoming.reading ?? []).map((e) => ({
          ...e,
          kind: (READING_KINDS.includes(e.kind as AnnotationKind)
            ? e.kind
            : "english") as AnnotationKind,
          reading: e.reading ?? "",
        })),
      });
    } catch (e) {
      setStatus(`読込失敗: ${e}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const persist = async (next: Dictionaries) => {
    setDicts(next);
    setSaving(true);
    try {
      const saved = await invoke<Dictionaries>("set_dictionaries", {
        dicts: { ...next, reading: next.reading ?? [], homograph: [] },
      });
      setDicts(saved);
      emitDictionariesChanged();
      setStatus("保存しました");
    } catch (e) {
      setStatus(`保存失敗: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const addReplace = () => {
    const entry: ReplaceEntry = {
      id: newDictId(),
      from: "",
      to: "",
      enabled: true,
      autoReplace: false,
    };
    void persist({ ...dicts, replace: [...dicts.replace, entry] });
  };

  const addReading = () => {
    const entry: ReadingDictEntry = {
      id: newDictId(),
      kind: "english",
      surface: "",
      reading: "",
      enabled: true,
    };
    void persist({ ...dicts, reading: [...(dicts.reading ?? []), entry] });
  };

  return (
    <div className="dictionary-view">
      <header className="panel-header">
        <h2>辞書</h2>
        <span className="hint">{status}</span>
      </header>

      <section
        className={`panel dict-section${replaceCollapsed ? " collapsed" : ""}`}
      >
        <header
          className="panel-header"
          onClick={() => setReplaceCollapsed((v) => !v)}
        >
          <h3>置換辞書</h3>
          <div className="panel-header-end">
            <button
              type="button"
              disabled={saving}
              onClick={(ev) => {
                ev.stopPropagation();
                if (replaceCollapsed) setReplaceCollapsed(false);
                addReplace();
              }}
            >
              追加
            </button>
            <span className="chevron">{replaceCollapsed ? "▸" : "▾"}</span>
          </div>
        </header>
        {!replaceCollapsed && (
        <div className="panel-body">
          <p className="hint">
            左のチェックは一括語句置換の対象。右のチェックは入力時の自動置換（既定 OFF）。長い
            from を優先します。
          </p>
          {dicts.replace.length === 0 && (
            <p className="hint">（空）</p>
          )}
          <ul className="dict-list">
            {dicts.replace.map((e, i) => (
              <li
                key={e.id}
                className={`dict-row dict-row-replace${
                  e.enabled ? " has-auto" : ""
                }`}
              >
                <label
                  className="dict-check"
                  title="一括語句置換の対象（Active）"
                >
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    aria-label="一括語句置換の対象"
                    onChange={(ev) => {
                      const on = ev.target.checked;
                      const replace = [...dicts.replace];
                      replace[i] = {
                        ...e,
                        enabled: on,
                        // 無効化時は自動もオフ（チェック非表示のため）
                        autoReplace: on ? e.autoReplace : false,
                      };
                      void persist({ ...dicts, replace });
                    }}
                  />
                  <span className="dict-check-label">有効</span>
                </label>
                {e.enabled && (
                  <label
                    className="dict-check"
                    title="入力時に自動置換"
                  >
                    <input
                      type="checkbox"
                      checked={!!e.autoReplace}
                      aria-label="入力時に自動置換"
                      onChange={(ev) => {
                        const replace = [...dicts.replace];
                        replace[i] = {
                          ...e,
                          autoReplace: ev.target.checked,
                        };
                        void persist({ ...dicts, replace });
                      }}
                    />
                    <span className="dict-check-label">自動</span>
                  </label>
                )}
                <input
                  value={e.from}
                  placeholder="from"
                  onChange={(ev) => {
                    const replace = [...dicts.replace];
                    replace[i] = { ...e, from: ev.target.value };
                    setDicts({ ...dicts, replace });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <span className="dict-arrow">→</span>
                <input
                  value={e.to}
                  placeholder="to"
                  onChange={(ev) => {
                    const replace = [...dicts.replace];
                    replace[i] = { ...e, to: ev.target.value };
                    setDicts({ ...dicts, replace });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void persist({
                      ...dicts,
                      replace: dicts.replace.filter((x) => x.id !== e.id),
                    });
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
        )}
      </section>

      <section
        className={`panel dict-section${readingCollapsed ? " collapsed" : ""}`}
      >
        <header
          className="panel-header"
          onClick={() => setReadingCollapsed((v) => !v)}
        >
          <h3>読み辞書</h3>
          <div className="panel-header-end">
            <button
              type="button"
              disabled={saving}
              onClick={(ev) => {
                ev.stopPropagation();
                if (readingCollapsed) setReadingCollapsed(false);
                addReading();
              }}
            >
              追加
            </button>
            <span className="chevron">{readingCollapsed ? "▸" : "▾"}</span>
          </div>
        </header>
        {!readingCollapsed && (
        <div className="panel-body">
          <p className="hint">
            英単語・同形異音・数字の拡張候補です。警告は出たまま、行ごとに読みを選びます（自動確定しません）。辞書にない読みを指定したときだけここに足されます。同形異音の表層追加もここです（内蔵 UniDic と併用）。複数の読みは / で区切ってください。
          </p>
          {(dicts.reading ?? []).length === 0 && (
            <p className="hint">（空）</p>
          )}
          <ul className="dict-list">
            {(dicts.reading ?? []).map((e, i) => (
              <li key={e.id} className="dict-row dict-row-reading">
                <label className="dict-check">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={(ev) => {
                      const reading = [...(dicts.reading ?? [])];
                      reading[i] = { ...e, enabled: ev.target.checked };
                      void persist({ ...dicts, reading });
                    }}
                  />
                </label>
                <select
                  value={e.kind}
                  onChange={(ev) => {
                    const reading = [...(dicts.reading ?? [])];
                    reading[i] = {
                      ...e,
                      kind: ev.target.value as AnnotationKind,
                    };
                    setDicts({ ...dicts, reading });
                  }}
                  onBlur={() => void persist(dicts)}
                >
                  {READING_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ANNOTATION_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <input
                  value={e.surface}
                  placeholder="表層"
                  onChange={(ev) => {
                    const reading = [...(dicts.reading ?? [])];
                    reading[i] = { ...e, surface: ev.target.value };
                    setDicts({ ...dicts, reading });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <span className="dict-arrow">→</span>
                <input
                  value={e.reading}
                  placeholder="読み（例: きょう/こんにち）"
                  onChange={(ev) => {
                    const reading = [...(dicts.reading ?? [])];
                    reading[i] = { ...e, reading: ev.target.value };
                    setDicts({ ...dicts, reading });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void persist({
                      ...dicts,
                      reading: (dicts.reading ?? []).filter((x) => x.id !== e.id),
                    });
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
        )}
      </section>
    </div>
  );
}
