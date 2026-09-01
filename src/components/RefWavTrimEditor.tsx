import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

type Props = {
  wavPath: string;
  onAdopt: (newPath: string) => void;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function RefWavTrimEditor({ wavPath, onAdopt }: Props) {
  const [duration, setDuration] = useState(0);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!wavPath.trim()) {
        setDuration(0);
        setStartSec(0);
        setEndSec(0);
        return;
      }
      try {
        const exists = await invoke<boolean>("file_exists", { path: wavPath });
        if (!exists) {
          setMsg("ファイルが見つかりません");
          return;
        }
        const dur = await invoke<number>("wav_duration_secs", { path: wavPath });
        if (cancelled) return;
        setDuration(dur);
        setEndSec(dur);
        setStartSec(0);
        setMsg("");
        const bytes = await invoke<number[]>("read_file_bytes", { path: wavPath });
        if (cancelled) return;
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
        );
        blobUrlRef.current = url;
        if (!audioRef.current) audioRef.current = new Audio();
        audioRef.current.src = url;
      } catch (e) {
        if (!cancelled) setMsg(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = "";
      }
    };
  }, [wavPath]);

  const playSelection = async () => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const start = clamp(startSec, 0, Math.max(0, duration - 0.05));
    const end = clamp(endSec, start + 0.05, duration);
    audio.currentTime = start;
    try {
      await audio.play();
    } catch {
      /* */
    }
    const onTime = () => {
      if (audio.currentTime >= end) {
        audio.pause();
        audio.removeEventListener("timeupdate", onTime);
      }
    };
    audio.addEventListener("timeupdate", onTime);
  };

  const adoptTrim = async () => {
    if (!wavPath.trim() || duration <= 0) return;
    const start = clamp(startSec, 0, Math.max(0, duration - 0.05));
    const end = clamp(endSec, start + 0.05, duration);
    const dest = await save({
      defaultPath: wavPath.replace(/(\.[^.\\/]+)?$/, "_trim.wav"),
      filters: [{ name: "WAV", extensions: ["wav"] }],
    });
    if (!dest) return;
    setBusy(true);
    setMsg("");
    try {
      const out = await invoke<string>("trim_ref_wav", {
        src: wavPath,
        dest,
        startSec: start,
        endSec: end,
      });
      onAdopt(out);
      setMsg("切り出しを参照音源に採用しました");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!wavPath.trim()) return null;

  return (
    <div className="ref-wav-trim">
      <span className="ref-wavs-label">範囲切り出し</span>
      <div className="ref-trim-range">
        <label>
          開始 (秒)
          <input
            type="number"
            min={0}
            max={Math.max(0, duration)}
            step={0.01}
            value={Number(startSec.toFixed(2))}
            onChange={(e) => setStartSec(Number(e.target.value) || 0)}
          />
        </label>
        <label>
          終了 (秒)
          <input
            type="number"
            min={0}
            max={Math.max(0, duration)}
            step={0.01}
            value={Number(endSec.toFixed(2))}
            onChange={(e) => setEndSec(Number(e.target.value) || 0)}
          />
        </label>
        {duration > 0 && (
          <span className="hint">長さ {duration.toFixed(2)} 秒</span>
        )}
      </div>
      <div className="row">
        <button type="button" onClick={() => void playSelection()}>
          選択範囲を再生
        </button>
        <button type="button" disabled={busy} onClick={() => void adoptTrim()}>
          切り出して参照に採用
        </button>
      </div>
      {msg && <span className="status-text">{msg}</span>}
    </div>
  );
}
