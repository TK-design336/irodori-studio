import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  emptyDictionaries,
  newDictId,
  type Dictionaries,
  type HomographEntry,
} from "../lib/dictionaries";
import type { ReplaceEntry } from "../lib/replaceApply";

export function DictionaryView() {
  const [dicts, setDicts] = useState<Dictionaries>(emptyDictionaries());
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await invoke<Dictionaries>("get_dictionaries");
      setDicts(d ?? emptyDictionaries());
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
        dicts: next,
      });
      setDicts(saved);
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

  const addHomograph = () => {
    const entry: HomographEntry = {
      id: newDictId(),
      surface: "",
      note: "",
      enabled: true,
    };
    void persist({ ...dicts, homograph: [...dicts.homograph, entry] });
  };

  return (
    <div className="dictionary-view">
      <header className="panel-header">
        <h2>辞書</h2>
        <span className="hint">{status}</span>
      </header>

      <section className="panel dict-section">
        <div className="panel-header">
          <h3>置換辞書</h3>
          <button type="button" onClick={addReplace} disabled={saving}>
            追加
          </button>
        </div>
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
      </section>

      <section className="panel dict-section">
        <div className="panel-header">
          <h3>同形異音辞書</h3>
          <button type="button" onClick={addHomograph} disabled={saving}>
            追加
          </button>
        </div>
        <div className="panel-body">
          <p className="hint">
            UniDic（書き言葉・話し言葉）から抽出した同形異音辞書を内蔵しています。形態素解析で表層が一致した語を警告表示します。下の一覧は追加のユーザー辞書で、登録した語句も非編集時に「同形異音警告」ハイライトされます（内蔵辞書と併用）。
          </p>
          {dicts.homograph.length === 0 && (
            <p className="hint">（空）</p>
          )}
          <ul className="dict-list">
            {dicts.homograph.map((e, i) => (
              <li key={e.id} className="dict-row dict-row-homo">
                <label className="dict-check">
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={(ev) => {
                      const homograph = [...dicts.homograph];
                      homograph[i] = { ...e, enabled: ev.target.checked };
                      void persist({ ...dicts, homograph });
                    }}
                  />
                </label>
                <input
                  value={e.surface}
                  placeholder="表層（例: 今日）"
                  onChange={(ev) => {
                    const homograph = [...dicts.homograph];
                    homograph[i] = { ...e, surface: ev.target.value };
                    setDicts({ ...dicts, homograph });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <input
                  value={e.note ?? ""}
                  placeholder="メモ（任意）"
                  onChange={(ev) => {
                    const homograph = [...dicts.homograph];
                    homograph[i] = { ...e, note: ev.target.value };
                    setDicts({ ...dicts, homograph });
                  }}
                  onBlur={() => void persist(dicts)}
                />
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void persist({
                      ...dicts,
                      homograph: dicts.homograph.filter((x) => x.id !== e.id),
                    });
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
