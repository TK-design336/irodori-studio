import { useCallback, useEffect, useRef, useState } from "react";
import { startLineDictation, stopLineDictation } from "./lineDictation";

export function useTextDictation(apply: (insert: string, commit: boolean) => void) {
  const [dictating, setDictating] = useState(false);
  const [dictationPhase, setDictationPhase] = useState<"off" | "starting" | "on">(
    "off",
  );
  const [dictationLevel, setDictationLevel] = useState(0);
  const [dictationHint, setDictationHint] = useState("");
  const dictatingRef = useRef(false);
  const dictationTokenRef = useRef(0);
  const dictationGenRef = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    return () => {
      dictationGenRef.current += 1;
      const token = dictationTokenRef.current;
      const wasDictating = dictatingRef.current || token !== 0;
      dictationTokenRef.current = 0;
      dictatingRef.current = false;
      if (token) void stopLineDictation(token);
      else if (wasDictating) void stopLineDictation();
    };
  }, []);

  const stopDictation = useCallback(async () => {
    dictationGenRef.current += 1;
    const token = dictationTokenRef.current;
    dictationTokenRef.current = 0;
    dictatingRef.current = false;
    setDictating(false);
    setDictationPhase("off");
    setDictationLevel(0);
    setDictationHint("");
    await stopLineDictation(token || undefined);
  }, []);

  const toggleDictation = useCallback(async () => {
    if (dictatingRef.current || dictationPhase === "starting") {
      await stopDictation();
      return;
    }
    const gen = ++dictationGenRef.current;
    dictatingRef.current = true;
    setDictating(true);
    setDictationPhase("starting");
    setDictationHint("準備中…");
    setDictationLevel(0);
    try {
      const { token } = await startLineDictation(
        {
          onLevel: (level) => {
            if (!dictatingRef.current) return;
            setDictationLevel(level);
          },
          onPartial: (text) => applyRef.current(text, false),
          onSegment: (text) => applyRef.current(text, true),
          onStatus: (msg) => {
            if (!dictatingRef.current) return;
            if (msg.includes("準備") || msg.includes("失敗") || msg.includes("エラー")) {
              setDictationHint(msg);
            } else {
              setDictationHint("");
            }
          },
          onError: (msg) => {
            if (!dictatingRef.current) return;
            setDictationHint(msg);
          },
        },
        (stolenToken) => {
          if (dictationGenRef.current !== gen) return;
          if (
            dictationTokenRef.current !== 0 &&
            dictationTokenRef.current !== stolenToken
          ) {
            return;
          }
          dictationGenRef.current += 1;
          dictationTokenRef.current = 0;
          dictatingRef.current = false;
          setDictating(false);
          setDictationPhase("off");
          setDictationLevel(0);
          setDictationHint("");
        },
      );
      if (dictationGenRef.current !== gen) {
        if (token) void stopLineDictation(token);
        return;
      }
      if (!dictatingRef.current || token === 0) {
        dictatingRef.current = false;
        setDictating(false);
        setDictationPhase("off");
        setDictationHint("");
        return;
      }
      dictationTokenRef.current = token;
      setDictationPhase("on");
      setDictationHint("");
    } catch (error) {
      if (dictationGenRef.current !== gen) return;
      dictatingRef.current = false;
      dictationTokenRef.current = 0;
      setDictating(false);
      setDictationPhase("off");
      setDictationHint(String(error));
    }
  }, [dictationPhase, stopDictation]);

  return {
    dictating,
    dictatingRef,
    dictationPhase,
    dictationLevel,
    dictationHint,
    dictationError: Boolean(dictationHint && !dictating),
    toggleDictation,
    stopDictation,
  };
}
