import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BlendTernaryPlot,
  formatBlendPercents,
  type BlendWeights,
} from "./BlendTernaryPlot";
import type { SpeakerInfo } from "../types";
import { speakerOptionLabel, speakerRealName } from "../types";
import { noteSpeakerRename } from "../lib/speakerResolve";

type Props = {
  speakers: SpeakerInfo[];
  onSpeakersChanged: () => void;
  isV4: boolean;
};

type ProfileKind = "ref" | "caption";

type SortKey = "name" | "realName" | "gender" | "age" | "tag";
type SortDir = "asc" | "desc";
type KindFilterKey = "trained" | "blend" | "ref" | "caption";

type ConfirmState = {
  message: string;
  onYes: () => void;
};

const SPEAKER_KIND_LABEL: Record<string, string> = {
  trained: "埋め込み",
  blend: "ブレンド",
  ref: "参照音源",
  caption: "キャプション",
};

const KIND_FILTERS: { key: KindFilterKey; label: string }[] = [
  { key: "trained", label: "埋め込み" },
  { key: "blend", label: "ブレンド" },
  { key: "ref", label: "参照音源" },
  { key: "caption", label: "キャプション" },
];

const SORT_BUTTONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "名前" },
  { key: "realName", label: "本名" },
  { key: "gender", label: "性別" },
  { key: "age", label: "年齢帯" },
  { key: "tag", label: "タグ" },
];

const GENDER_OPTIONS = [
  { value: "", label: "性別" },
  { value: "female", label: "女性" },
  { value: "male", label: "男性" },
  { value: "other", label: "その他" },
];

const AGE_OPTIONS = [
  { value: "", label: "年齢帯" },
  { value: "child", label: "子供" },
  { value: "teen", label: "青年" },
  { value: "adult", label: "成人" },
  { value: "middle", label: "中年" },
  { value: "senior", label: "老年" },
];

const GENDER_ORDER: Record<string, number> = { female: 0, male: 1, other: 2 };
const AGE_ORDER: Record<string, number> = {
  child: 0,
  teen: 1,
  adult: 2,
  middle: 3,
  senior: 4,
};

function speakerTags(sp: Pick<SpeakerInfo, "tags">): string[] {
  return (sp.tags ?? []).map((t) => t.trim()).filter(Boolean);
}

function addUniqueTag(tags: string[], raw: string): string[] {
  const tag = raw.trim();
  if (!tag || tags.includes(tag)) return tags;
  return [...tags, tag];
}

function cmpOptionalOrder(
  a: string | null | undefined,
  b: string | null | undefined,
  order: Record<string, number>,
  dir: number,
): number {
  const ae = !a;
  const be = !b;
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  return ((order[a] ?? 99) - (order[b] ?? 99)) * dir;
}

export function SpeakerView({ speakers, onSpeakersChanged, isV4 }: Props) {
  // ── 折りたたみ状態 ──
  const [manageCollapsed, setManageCollapsed] = useState(false);
  const [blendCollapsed, setBlendCollapsed] = useState(false);

  // ── ブレンド ──
  const [embedA, setEmbedA] = useState("");
  const [embedB, setEmbedB] = useState("");
  const [embedC, setEmbedC] = useState("");
  const [weights, setWeights] = useState<BlendWeights>({ a: 0.5, b: 0.5, c: 0 });
  const [blendName, setBlendName] = useState("");
  const [blendMsg, setBlendMsg] = useState("");

  // ── プロファイル編集 ──
  const [profileEditPath, setProfileEditPath] = useState<string | null>(null);
  const [profileKind, setProfileKind] = useState<ProfileKind>("ref");
  const [profileName, setProfileName] = useState("");
  const [profileRefWavs, setProfileRefWavs] = useState<string[]>([""]);
  const [profileCaption, setProfileCaption] = useState("");
  const [profileGender, setProfileGender] = useState("");
  const [profileAgeRange, setProfileAgeRange] = useState("");
  const [profileRealName, setProfileRealName] = useState("");
  const [profileTags, setProfileTags] = useState<string[]>([]);
  const [profileTagDraft, setProfileTagDraft] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  // ── ソート / 表示種 ──
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [kindFilter, setKindFilter] = useState<Record<KindFilterKey, boolean>>({
    trained: true,
    blend: true,
    ref: true,
    caption: true,
  });
  const [listTagDrafts, setListTagDrafts] = useState<Record<string, string>>({});
  const [listRealNameDrafts, setListRealNameDrafts] = useState<Record<string, string>>({});
  const [listNameDrafts, setListNameDrafts] = useState<Record<string, string>>({});
  const [editingNamePath, setEditingNamePath] = useState<string | null>(null);
  const nameEditRef = useRef<HTMLInputElement>(null);
  const skipNameCommitRef = useRef(false);

  useEffect(() => {
    if (!editingNamePath) return;
    const el = nameEditRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingNamePath]);

  // ── 確認モーダル ──
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  // ── 派生データ ──
  const embedSpeakers = useMemo(
    () => speakers.filter((s) => s.kind === "trained" || s.kind === "blend"),
    [speakers],
  );

  const visibleSpeakers = useMemo(() => {
    const filtered = speakers.filter((s) => {
      const k = s.kind as KindFilterKey;
      return kindFilter[k] ?? true;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const copy = [...filtered];
    copy.sort((a, b) => {
      let primary = 0;
      if (sortKey === "name") {
        primary = a.name.localeCompare(b.name, "ja") * dir;
      } else if (sortKey === "realName") {
        primary = speakerRealName(a).localeCompare(speakerRealName(b), "ja") * dir;
      } else if (sortKey === "gender") {
        primary = cmpOptionalOrder(a.gender, b.gender, GENDER_ORDER, dir);
      } else if (sortKey === "age") {
        primary = cmpOptionalOrder(a.ageRange, b.ageRange, AGE_ORDER, dir);
      } else {
        const at = speakerTags(a).join(",");
        const bt = speakerTags(b).join(",");
        if (!at && !bt) primary = 0;
        else if (!at) primary = 1;
        else if (!bt) primary = -1;
        else primary = at.localeCompare(bt, "ja") * dir;
      }
      return primary !== 0 ? primary : a.name.localeCompare(b.name, "ja");
    });
    return copy;
  }, [speakers, kindFilter, sortKey, sortDir]);

  const speakerOptions = useMemo(
    () => [
      { value: "", label: "選択…" },
      ...embedSpeakers.map((s) => ({
        value: s.embedPath,
        label: speakerOptionLabel(s),
      })),
    ],
    [embedSpeakers],
  );

  const nameA = embedSpeakers.find((s) => s.embedPath === embedA)?.name ?? "A";
  const nameB = embedSpeakers.find((s) => s.embedPath === embedB)?.name ?? "B";
  const nameC = embedSpeakers.find((s) => s.embedPath === embedC)?.name ?? "C";

  const setEmbedCAndSnap = (v: string) => {
    setEmbedC(v);
    if (!v) {
      setWeights((w) => {
        const s = w.a + w.b;
        return s > 0 ? { a: w.a / s, b: w.b / s, c: 0 } : { a: 0.5, b: 0.5, c: 0 };
      });
    }
  };

  // ── 参照音源リスト操作 ──
  const setRefWavAt = (idx: number, val: string) =>
    setProfileRefWavs((prev) => prev.map((v, i) => (i === idx ? val : v)));

  const addRefWav = () => setProfileRefWavs((prev) => [...prev, ""]);

  const removeRefWav = (idx: number) =>
    setProfileRefWavs((prev) => prev.filter((_, i) => i !== idx));

  const pickRefWavAt = async (idx: number) => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac"] }],
    });
    if (typeof selected === "string") setRefWavAt(idx, selected);
  };

  const stripPathQuotes = (raw: string): string => {
    let s = raw.trim();
    if (s.startsWith('"')) { s = s.slice(1); if (s.endsWith('"')) s = s.slice(0, -1); }
    else if (s.startsWith("'")) { s = s.slice(1); if (s.endsWith("'")) s = s.slice(0, -1); }
    return s.trim();
  };

  // ── フォームリセット ──
  const resetProfileForm = () => {
    setProfileEditPath(null);
    setProfileKind("ref");
    setProfileName("");
    setProfileRefWavs([""]);
    setProfileCaption("");
    setProfileGender("");
    setProfileAgeRange("");
    setProfileRealName("");
    setProfileTags([]);
    setProfileTagDraft("");
    setProfileMsg("");
  };

  const beginEditProfile = (sp: SpeakerInfo) => {
    setProfileEditPath(sp.embedPath);
    setProfileKind(sp.kind === "caption" ? "caption" : "ref");
    setProfileName(sp.name);
    const wavs = sp.refWavs && sp.refWavs.length > 0
      ? sp.refWavs
      : sp.refWav
        ? [sp.refWav]
        : [""];
    setProfileRefWavs(wavs);
    setProfileCaption(sp.caption ?? "");
    setProfileGender(sp.gender ?? "");
    setProfileAgeRange(sp.ageRange ?? "");
    setProfileRealName(speakerRealName(sp));
    setProfileTags(speakerTags(sp));
    setProfileTagDraft("");
    setProfileMsg(`編集中: ${sp.name}`);
  };

  // ── 保存 ──
  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) { setProfileMsg("話者名を入力してください"); return; }

    let kind: ProfileKind;
    let refWavs: string[] | null = null;
    let caption: string | null = null;

    if (isV4) {
      const wavList = profileRefWavs.map(stripPathQuotes).filter(Boolean);
      const hasCap = profileCaption.trim().length > 0;
      if (wavList.length === 0 && !hasCap) {
        setProfileMsg("参照音源またはキャプションのいずれかを入力してください");
        return;
      }
      kind = wavList.length > 0 ? "ref" : "caption";
      refWavs = wavList.length > 0 ? wavList : null;
      caption = hasCap ? profileCaption.trim() : null;
    } else {
      kind = profileKind;
      if (kind === "ref") {
        refWavs = profileRefWavs.map(stripPathQuotes).filter(Boolean);
        if (refWavs.length === 0) { setProfileMsg("参照音源のパスを指定してください"); return; }
      } else {
        caption = profileCaption.trim();
      }
    }

    setProfileBusy(true);
    setProfileMsg("");
    const tagsToSave = addUniqueTag(profileTags, profileTagDraft);
    if (profileTagDraft.trim()) {
      setProfileTags(tagsToSave);
      setProfileTagDraft("");
    }
    const realName = profileRealName.trim() || name;
    try {
      const saved = await invoke<SpeakerInfo>("upsert_speaker_profile_cmd", {
        args: {
          profilePath: profileEditPath,
          name,
          kind,
          refWav: refWavs?.[0] ?? null,
          refWavs: refWavs,
          caption,
          gender: profileGender || null,
          ageRange: profileAgeRange || null,
          tags: tagsToSave.length > 0 ? tagsToSave : null,
          realName,
        },
      });
      setProfileMsg(profileEditPath ? `更新しました: ${saved.name}` : `作成しました: ${saved.name}`);
      setProfileEditPath(saved.embedPath);
      setProfileRealName(saved.realName ?? realName);
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
    } finally {
      setProfileBusy(false);
    }
  };

  // ── 削除 ──
  const requestDeleteSpeaker = (sp: SpeakerInfo) => {
    const kindLabel = SPEAKER_KIND_LABEL[sp.kind] ?? sp.kind;
    const suffix =
      sp.kind === "trained"
        ? "（学習データフォルダごとゴミ箱に移動します）"
        : sp.kind === "blend"
          ? "（ブレンドファイルをゴミ箱に移動します）"
          : "（プロファイルをゴミ箱に移動します）";
    setConfirmState({
      message: `${kindLabel}話者「${sp.name}」を削除しますか？${suffix}`,
      onYes: () => void doDeleteSpeaker(sp),
    });
  };

  const doDeleteSpeaker = async (sp: SpeakerInfo) => {
    setProfileBusy(true);
    try {
      await invoke("delete_speaker_cmd", { embedPath: sp.embedPath, kind: sp.kind });
      if (profileEditPath === sp.embedPath) resetProfileForm();
      setProfileMsg(`削除しました: ${sp.name}`);
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
    } finally {
      setProfileBusy(false);
    }
  };

  const clickSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleKindFilter = (key: KindFilterKey) => {
    setKindFilter((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const sortDirMark = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const commitProfileTag = () => {
    const next = addUniqueTag(profileTags, profileTagDraft);
    if (next !== profileTags) setProfileTags(next);
    setProfileTagDraft("");
  };

  const saveSpeakerMeta = async (
    sp: SpeakerInfo,
    patch: {
      gender?: string | null;
      ageRange?: string | null;
      tags?: string[] | null;
      realName?: string | null;
    },
  ) => {
    const gender = patch.gender !== undefined ? patch.gender : (sp.gender ?? null);
    const ageRange = patch.ageRange !== undefined ? patch.ageRange : (sp.ageRange ?? null);
    const tags = patch.tags !== undefined ? patch.tags : speakerTags(sp);
    const realName = patch.realName !== undefined ? patch.realName : speakerRealName(sp);
    try {
      await invoke<SpeakerInfo>("update_speaker_meta_cmd", {
        args: {
          embedPath: sp.embedPath,
          kind: sp.kind,
          gender: gender || null,
          ageRange: ageRange || null,
          tags: tags && tags.length > 0 ? tags : null,
          realName: (realName ?? "").trim() || sp.name,
        },
      });
      if (profileEditPath === sp.embedPath) {
        if (patch.gender !== undefined) setProfileGender(patch.gender ?? "");
        if (patch.ageRange !== undefined) setProfileAgeRange(patch.ageRange ?? "");
        if (patch.tags !== undefined) setProfileTags(patch.tags ?? []);
        if (patch.realName !== undefined) {
          setProfileRealName((patch.realName ?? "").trim() || sp.name);
        }
      }
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
    }
  };

  const addListTag = (sp: SpeakerInfo) => {
    const draft = listTagDrafts[sp.embedPath] ?? "";
    const next = addUniqueTag(speakerTags(sp), draft);
    setListTagDrafts((prev) => ({ ...prev, [sp.embedPath]: "" }));
    if (next.length === speakerTags(sp).length) return;
    void saveSpeakerMeta(sp, { tags: next });
  };

  const commitListRealName = (sp: SpeakerInfo) => {
    const draft = (listRealNameDrafts[sp.embedPath] ?? speakerRealName(sp)).trim() || sp.name;
    setListRealNameDrafts((prev) => {
      const next = { ...prev };
      delete next[sp.embedPath];
      return next;
    });
    if (draft === speakerRealName(sp)) return;
    void saveSpeakerMeta(sp, { realName: draft });
  };

  const rekeyDrafts = (oldPath: string, newPath: string) => {
    const moveKey = (prev: Record<string, string>) => {
      if (!(oldPath in prev)) return prev;
      const next = { ...prev };
      const val = next[oldPath];
      delete next[oldPath];
      if (newPath) next[newPath] = val;
      return next;
    };
    setListTagDrafts(moveKey);
    setListRealNameDrafts(moveKey);
    setListNameDrafts(moveKey);
  };

  const beginNameEdit = (sp: SpeakerInfo) => {
    if (profileBusy) return;
    setListNameDrafts((prev) => ({ ...prev, [sp.embedPath]: sp.name }));
    setEditingNamePath(sp.embedPath);
  };

  const commitListName = async (sp: SpeakerInfo) => {
    const draft = (listNameDrafts[sp.embedPath] ?? sp.name).trim();
    if (!draft) {
      setProfileMsg("話者名を入力してください");
      setEditingNamePath(sp.embedPath);
      return;
    }
    if (draft === sp.name) {
      setListNameDrafts((prev) => {
        const next = { ...prev };
        delete next[sp.embedPath];
        return next;
      });
      setEditingNamePath((cur) => (cur === sp.embedPath ? null : cur));
      return;
    }
    setProfileBusy(true);
    setProfileMsg("");
    try {
      const saved = await invoke<SpeakerInfo>("rename_speaker_cmd", {
        args: { embedPath: sp.embedPath, kind: sp.kind, name: draft },
      });
      noteSpeakerRename(sp.embedPath, {
        embedPath: saved.embedPath,
        name: saved.name,
      });
      if (profileEditPath === sp.embedPath) {
        setProfileEditPath(saved.embedPath);
        setProfileName(saved.name);
      }
      setListNameDrafts((prev) => {
        const next = { ...prev };
        delete next[sp.embedPath];
        return next;
      });
      setEditingNamePath(null);
      rekeyDrafts(sp.embedPath, saved.embedPath);
      setProfileMsg(`話者名を変更しました: ${saved.name}`);
      onSpeakersChanged();
    } catch (e) {
      setProfileMsg(String(e));
      setEditingNamePath(sp.embedPath);
    } finally {
      setProfileBusy(false);
    }
  };

  const doBlend = async () => {
    if (!embedA || !embedB) { setBlendMsg("話者 A と B を選択してください"); return; }
    const ids = [embedA, embedB, embedC].filter(Boolean);
    if (new Set(ids).size !== ids.length) {
      setBlendMsg("同じ話者を複数回選べません");
      return;
    }
    const pct = formatBlendPercents(weights, Boolean(embedC));
    const name = blendName.trim() || (
      embedC
        ? `${nameA}${pct.a}_${nameB}${pct.b}_${nameC}${pct.c}`
        : `${nameA}_${nameB}_${pct.b}`
    );
    try {
      const out = await invoke<string>("blend_embeddings", {
        embedA,
        embedB,
        embedC: embedC || null,
        weightA: weights.a,
        weightB: weights.b,
        weightC: embedC ? weights.c : 0,
        outputName: name,
      });
      setBlendMsg(`保存: ${out}`);
      onSpeakersChanged();
    } catch (e) {
      setBlendMsg(String(e));
    }
  };

  const showRefCapSplit = !isV4;

  return (
    <div className="speaker-layout">
      {/* ── Section 1: 話者管理 ── */}
      <section className={`panel speaker-manage-panel${manageCollapsed ? " collapsed" : ""}`}>
        <header className="panel-header" onClick={() => setManageCollapsed((v) => !v)}>
          <h3>話者管理</h3>
          <span className="chevron">{manageCollapsed ? "▸" : "▾"}</span>
        </header>
        {!manageCollapsed && (
          <div className="panel-body form-stack">
            <div className="speaker-add-header">
              <h4>話者追加</h4>
              <span className="hint">
                {isV4
                  ? "v4 は統合モデルのため、参照音源とキャプションを1つの話者として管理します。参照音源は複数指定可能です。"
                  : "Embedding 学習なし。参照音源はゼロショットクローン、キャプションは声デザインです（VoiceDesign 系 Checkpoint が必要）。参照音源は複数指定可能です。"}
              </span>
            </div>

            {showRefCapSplit && (
              <div className="profile-kind-tabs" role="tablist">
                <button type="button" role="tab"
                  className={profileKind === "ref" ? "active" : ""}
                  aria-selected={profileKind === "ref"}
                  onClick={() => setProfileKind("ref")}>
                  参照音源
                </button>
                <button type="button" role="tab"
                  className={profileKind === "caption" ? "active" : ""}
                  aria-selected={profileKind === "caption"}
                  onClick={() => setProfileKind("caption")}>
                  キャプション
                </button>
              </div>
            )}

            <label>
              話者名
              <input value={profileName} onChange={(e) => setProfileName(e.target.value)}
                placeholder="例: Ref_Hanako / SoftVoice" />
            </label>

            <label>
              話者本名（俳優・声優名）
              <input
                value={profileRealName}
                onChange={(e) => setProfileRealName(e.target.value)}
                placeholder="空欄なら話者名と同じ"
              />
            </label>

            <div className="speaker-meta-fields">
              <label>
                性別
                <select
                  value={profileGender}
                  onChange={(e) => setProfileGender(e.target.value)}
                >
                  {GENDER_OPTIONS.map((o) => (
                    <option key={o.value || "none"} value={o.value}>
                      {o.value ? o.label : "未設定"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                年齢帯
                <select
                  value={profileAgeRange}
                  onChange={(e) => setProfileAgeRange(e.target.value)}
                >
                  {AGE_OPTIONS.map((o) => (
                    <option key={o.value || "none"} value={o.value}>
                      {o.value ? o.label : "未設定"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              手動タグ
              <div className="speaker-tag-editor">
                {profileTags.map((tag) => (
                  <span key={tag} className="speaker-tag-chip">
                    {tag}
                    <button
                      type="button"
                      title={`${tag} を削除`}
                      onClick={() => setProfileTags((prev) => prev.filter((t) => t !== tag))}
                    >×</button>
                  </span>
                ))}
                <input
                  value={profileTagDraft}
                  onChange={(e) => setProfileTagDraft(e.target.value)}
                  placeholder="入力して Enter"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      commitProfileTag();
                    }
                  }}
                  onBlur={commitProfileTag}
                />
              </div>
            </label>

            {/* 参照音源フィールド（ref / v4共通） */}
            {(isV4 || profileKind === "ref") && (
              <div className="ref-wavs-section">
                <span className="ref-wavs-label">
                  参照音源{isV4 ? "（任意）" : ""}
                </span>
                {isV4 && (
                  <p className="hint ref-wavs-hint">
                    複数ファイルを順に連結（v4）。推奨: 同一話者の短クリップ合計30秒前後（上限120秒・自動トリム）。長い単一ファイルは非推奨。
                  </p>
                )}
                {profileRefWavs.map((wav, idx) => (
                  <div key={idx} className="ref-wav-row">
                    <input
                      value={wav}
                      onChange={(e) => setRefWavAt(idx, e.target.value)}
                      placeholder="wav / mp3 / flac など"
                    />
                    <button type="button" onClick={() => void pickRefWavAt(idx)}>参照</button>
                    {profileRefWavs.length > 1 && (
                      <button type="button" className="danger icon-btn"
                        title="この音源を削除"
                        onClick={() => removeRefWav(idx)}>✕</button>
                    )}
                  </div>
                ))}
                {isV4 && (
                  <button type="button" className="ref-wav-add-btn" onClick={addRefWav}>
                    ＋ 音源を追加
                  </button>
                )}
              </div>
            )}

            {/* キャプションフィールド（caption / v4共通） */}
            {(isV4 || profileKind === "caption") && (
              <label>
                {isV4 ? "キャプション（任意）" : "キャプション（声のデザイン）"}
                <textarea className="profile-caption" rows={3}
                  value={profileCaption}
                  onChange={(e) => setProfileCaption(e.target.value)}
                  placeholder="例: 落ち着いた若い女性の声、少し息多め" />
              </label>
            )}

            <div className="row">
              <button type="button" className="primary" disabled={profileBusy}
                onClick={() => void saveProfile()}>
                {profileEditPath ? "更新" : "追加"}
              </button>
              {profileEditPath && (
                <button type="button" disabled={profileBusy} onClick={resetProfileForm}>
                  新規作成に切替
                </button>
              )}
              <span className="status-text">{profileMsg}</span>
            </div>

            {/* ── 話者リスト ── */}
            <hr />
            <div className="speaker-list-header">
              <h4>登録話者一覧</h4>
              <div className="speaker-list-toolbar">
                <div className="speaker-sort-row">
                  <span className="hint">表示種:</span>
                  {KIND_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={kindFilter[f.key] ? "sort-btn active" : "sort-btn"}
                      aria-pressed={kindFilter[f.key]}
                      title={kindFilter[f.key] ? "表示中（クリックで非表示）" : "非表示（クリックで表示）"}
                      onClick={() => toggleKindFilter(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="speaker-sort-row">
                  <span className="hint">並び替え:</span>
                  {SORT_BUTTONS.map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      className={sortKey === b.key ? "sort-btn active" : "sort-btn"}
                      title="クリックで昇順・降順を切替"
                      onClick={() => clickSort(b.key)}
                    >
                      {b.label}{sortDirMark(b.key)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="profile-list profile-list-scrollable">
              {speakers.length === 0 ? (
                <p className="hint">まだ登録された話者はありません</p>
              ) : visibleSpeakers.length === 0 ? (
                <p className="hint">表示種の選択に一致する話者はありません</p>
              ) : (
                visibleSpeakers.map((sp) => (
                  <div key={sp.embedPath}
                    className={`profile-list-item${profileEditPath === sp.embedPath ? " active" : ""}`}>
                    <div className="profile-list-main">
                      {editingNamePath === sp.embedPath ? (
                        <input
                          ref={nameEditRef}
                          className="speaker-name-input"
                          aria-label={`${sp.name} の話者名`}
                          title="Enter で確定 / Esc でキャンセル"
                          value={listNameDrafts[sp.embedPath] ?? sp.name}
                          disabled={profileBusy}
                          onChange={(e) => setListNameDrafts((prev) => ({
                            ...prev,
                            [sp.embedPath]: e.target.value,
                          }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              skipNameCommitRef.current = true;
                              setListNameDrafts((prev) => {
                                const next = { ...prev };
                                delete next[sp.embedPath];
                                return next;
                              });
                              setEditingNamePath(null);
                            }
                          }}
                          onBlur={() => {
                            if (skipNameCommitRef.current) {
                              skipNameCommitRef.current = false;
                              return;
                            }
                            void commitListName(sp);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="speaker-name-edit-btn"
                          aria-label={`${sp.name} の話者名を編集`}
                          title="クリックして話者名を編集"
                          disabled={profileBusy}
                          onClick={() => beginNameEdit(sp)}
                        >
                          {sp.name}
                        </button>
                      )}
                      <span className="profile-kind-badge">
                        {SPEAKER_KIND_LABEL[sp.kind] ?? sp.kind}
                      </span>
                      <input
                        className="speaker-realname-input"
                        aria-label={`${sp.name} の話者本名`}
                        title="話者本名（俳優・声優名）"
                        value={listRealNameDrafts[sp.embedPath] ?? speakerRealName(sp)}
                        disabled={profileBusy}
                        placeholder="本名"
                        onChange={(e) => setListRealNameDrafts((prev) => ({
                          ...prev,
                          [sp.embedPath]: e.target.value,
                        }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        onBlur={() => commitListRealName(sp)}
                      />
                      <select
                        className="speaker-meta-select"
                        aria-label={`${sp.name} の性別`}
                        value={sp.gender ?? ""}
                        disabled={profileBusy}
                        onChange={(e) => void saveSpeakerMeta(sp, { gender: e.target.value || null })}
                      >
                        {GENDER_OPTIONS.map((o) => (
                          <option key={o.value || "none"} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <select
                        className="speaker-meta-select"
                        aria-label={`${sp.name} の年齢帯`}
                        value={sp.ageRange ?? ""}
                        disabled={profileBusy}
                        onChange={(e) => void saveSpeakerMeta(sp, { ageRange: e.target.value || null })}
                      >
                        {AGE_OPTIONS.map((o) => (
                          <option key={o.value || "none"} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      {speakerTags(sp).map((tag) => (
                        <span key={tag} className="speaker-tag-chip">
                          {tag}
                          <button
                            type="button"
                            disabled={profileBusy}
                            title={`${tag} を削除`}
                            onClick={() => void saveSpeakerMeta(sp, {
                              tags: speakerTags(sp).filter((t) => t !== tag),
                            })}
                          >×</button>
                        </span>
                      ))}
                      <input
                        className="speaker-tag-input"
                        aria-label={`${sp.name} にタグを追加`}
                        value={listTagDrafts[sp.embedPath] ?? ""}
                        disabled={profileBusy}
                        placeholder="タグ追加"
                        onChange={(e) => setListTagDrafts((prev) => ({
                          ...prev,
                          [sp.embedPath]: e.target.value,
                        }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === ",") {
                            e.preventDefault();
                            addListTag(sp);
                          }
                        }}
                        onBlur={() => addListTag(sp)}
                      />
                      <span className="profile-list-detail"
                        title={
                          sp.kind === "ref"
                            ? (sp.refWavs?.join(", ") ?? sp.refWav ?? "")
                            : sp.kind === "caption"
                              ? (sp.caption ?? "")
                              : sp.embedPath
                        }>
                        {sp.kind === "ref"
                          ? sp.refWavs && sp.refWavs.length > 1
                            ? `${sp.refWavs.length}ファイル`
                            : (sp.refWav ?? "")
                          : sp.kind === "caption"
                            ? (sp.caption ?? "")
                            : ""}
                      </span>
                    </div>
                    <div className="row profile-list-actions">
                      {(sp.kind === "ref" || sp.kind === "caption") && (
                        <button type="button" disabled={profileBusy}
                          onClick={() => beginEditProfile(sp)}>編集</button>
                      )}
                      <button type="button" className="danger" disabled={profileBusy}
                        onClick={() => requestDeleteSpeaker(sp)}>削除</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Section 2: 埋め込み話者ブレンド ── */}
      <section className={`panel speaker-blend-panel${blendCollapsed ? " collapsed" : ""}`}>
        <header className="panel-header" onClick={() => setBlendCollapsed((v) => !v)}>
          <h3>埋め込み話者ブレンド（最大3人）</h3>
          <span className="chevron">{blendCollapsed ? "▸" : "▾"}</span>
        </header>
        {!blendCollapsed && (
          <div className="panel-body form-stack">
            <BlendTernaryPlot
              options={speakerOptions}
              embedA={embedA}
              embedB={embedB}
              embedC={embedC}
              onEmbedA={setEmbedA}
              onEmbedB={setEmbedB}
              onEmbedC={setEmbedCAndSnap}
              weights={weights}
              onWeightsChange={setWeights}
              nameA={nameA}
              nameB={nameB}
              nameC={nameC}
            />
            <label>
              出力名
              <input value={blendName} onChange={(e) => setBlendName(e.target.value)}
                placeholder="空欄なら自動命名" />
            </label>
            <div className="row">
              <button type="button" className="primary" onClick={doBlend}>ブレンド保存</button>
              <span className="status-text">{blendMsg}</span>
            </div>
          </div>
        )}
      </section>

      {/* ── 削除確認モーダル ── */}
      {confirmState && (
        <div className="modal-backdrop" onClick={() => setConfirmState(null)}>
          <div className="modal panel" onClick={(e) => e.stopPropagation()}>
            <header className="panel-header">
              <h3>確認</h3>
            </header>
            <div className="panel-body form-stack">
              <p>{confirmState.message}</p>
              <div className="row">
                <button type="button" className="primary"
                  onClick={() => { const fn = confirmState.onYes; setConfirmState(null); fn(); }}>
                  OK
                </button>
                <button type="button" onClick={() => setConfirmState(null)}>キャンセル</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
