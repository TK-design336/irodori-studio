import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GenerateView } from "./components/GenerateView";
import { SettingsView } from "./components/SettingsView";
import { TrainView } from "./components/TrainView";
import { SpeakerView } from "./components/SpeakerView";
import { DictionaryView } from "./components/DictionaryView";
import { SpeakerSortProvider } from "./components/SpeakerSortContext";
import { IconMoon, IconSun } from "./components/icons";
import type {
  AppSettings,
  PathValidation,
  Project,
  SpeakerInfo,
} from "./types";
import { isIrodoriV4 } from "./types";
import { applyAppearance } from "./lib/accent";
import "./App.css";

type Tab = "generate" | "speaker" | "train" | "dictionary" | "settings";

function App() {
  const [tab, setTab] = useState<Tab>("generate");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [validation, setValidation] = useState<PathValidation | null>(null);
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([]);
  const [training, setTraining] = useState(false);
  const [setupIncomplete, setSetupIncomplete] = useState(false);

  const [openProjects, setOpenProjects] = useState<Project[]>([]);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(
    null,
  );
  const [projectNameDraft, setProjectNameDraft] = useState("");

  const activeProject =
    openProjects.find((p) => p.name === activeProjectName) ?? null;

  const handleTrainingChange = useCallback((running: boolean) => {
    setTraining(running);
    if (running) setTab("train");
  }, []);

  const selectTab = useCallback(
    (next: Tab) => {
      if (training && next !== "train") return;
      if (setupIncomplete && next !== "settings") return;
      setTab(next);
    },
    [training, setupIncomplete],
  );

  const refreshValidation = useCallback(async () => {
    const v = await invoke<PathValidation>("validate_paths");
    setValidation(v);
  }, []);

  const refreshSpeakers = useCallback(async () => {
    try {
      const list = await invoke<SpeakerInfo[]>("list_speakers");
      setSpeakers((prev) =>
        JSON.stringify(prev) === JSON.stringify(list) ? prev : list,
      );
    } catch {
      setSpeakers((prev) => (prev.length === 0 ? prev : []));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const first = await invoke<boolean>("needs_first_setup_cmd");
      const s = await invoke<AppSettings>("get_settings");
      if (!s.theme) s.theme = "light";
      setSettings(s);
      applyAppearance(s.theme, s.accentLight, s.accentDark);
      setSetupIncomplete(first);
      if (first) setTab("settings");
      await refreshValidation();
      await refreshSpeakers();
    })();
  }, [refreshValidation, refreshSpeakers]);

  useEffect(() => {
    if (!settings) return;
    applyAppearance(settings.theme, settings.accentLight, settings.accentDark);
  }, [settings?.theme, settings?.accentLight, settings?.accentDark]);

  useEffect(() => {
    const onFocus = () => void refreshSpeakers();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(() => void refreshSpeakers(), 2500);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [refreshSpeakers]);

  const handleProjectChange = useCallback(
    (p: Project | null) => {
      if (!p) {
        setOpenProjects([]);
        setActiveProjectName(null);
        return;
      }
      const prevName = activeProjectName;
      setOpenProjects((prev) => {
        if (prevName) {
          const i = prev.findIndex((x) => x.name === prevName);
          if (i >= 0) {
            const next = [...prev];
            next[i] = p;
            return next;
          }
        }
        const i = prev.findIndex((x) => x.name === p.name);
        if (i >= 0) {
          const next = [...prev];
          next[i] = p;
          return next;
        }
        return [...prev, p];
      });
      setActiveProjectName(p.name);
    },
    [activeProjectName],
  );

  const toggleTheme = useCallback(async () => {
    if (!settings) return;
    const next = settings.theme === "dark" ? "light" : "dark";
    applyAppearance(next, settings.accentLight, settings.accentDark);
    const updated = { ...settings, theme: next };
    setSettings(updated);
    try {
      const saved = await invoke<AppSettings>("set_settings", {
        settings: updated,
      });
      setSettings(saved);
    } catch {
      /* keep optimistic UI */
    }
  }, [settings]);

  if (!settings) {
    return <div className="boot">Irodori Studio を起動中…</div>;
  }

  return (
    <SpeakerSortProvider>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <strong>Irodori Studio</strong>
        </div>
        <nav className="tabs">
          <button
            type="button"
            className={tab === "generate" ? "active" : ""}
            disabled={training || setupIncomplete}
            title={
              setupIncomplete
                ? "先に Irodori ルートを設定してください"
                : training
                  ? "学習中は生成画面へ移動できません"
                  : undefined
            }
            onClick={() => selectTab("generate")}
          >
            生成
          </button>
          <button
            type="button"
            className={tab === "speaker" ? "active" : ""}
            disabled={training || setupIncomplete}
            title={
              setupIncomplete
                ? "先に Irodori ルートを設定してください"
                : training
                  ? "学習中は話者画面へ移動できません"
                  : undefined
            }
            onClick={() => selectTab("speaker")}
          >
            話者
          </button>
          <button
            type="button"
            className={tab === "train" ? "active" : ""}
            disabled={setupIncomplete}
            title={
              setupIncomplete
                ? "先に Irodori ルートを設定してください"
                : undefined
            }
            onClick={() => selectTab("train")}
          >
            学習
          </button>
          <button
            type="button"
            className={tab === "dictionary" ? "active" : ""}
            disabled={training || setupIncomplete}
            title={
              setupIncomplete
                ? "先に Irodori ルートを設定してください"
                : training
                  ? "学習中は辞書画面へ移動できません"
                  : undefined
            }
            onClick={() => selectTab("dictionary")}
          >
            辞書
          </button>
          <button
            type="button"
            className={tab === "settings" ? "active" : ""}
            disabled={training}
            title={
              training ? "学習中は設定画面へ移動できません" : undefined
            }
            onClick={() => selectTab("settings")}
          >
            設定
          </button>
        </nav>
        <div className="topbar-meta">
          <span
            className={`pill ${isIrodoriV4(settings) ? "ver-v4" : "ver-v3"}`}
            title="設定で切替"
          >
            {isIrodoriV4(settings) ? "v4" : "v3"}
          </span>
          {validation && (
            <span
              className={`pill ${
                validation.pythonOk && validation.checkpointOk ? "ok" : "warn"
              }`}
            >
              {validation.pythonOk && validation.checkpointOk
                ? "Irodori 接続OK"
                : "パス要確認"}
            </span>
          )}
          <button
            type="button"
            className={`theme-switch ${
              settings.theme === "dark" ? "is-dark" : "is-light"
            }`}
            onClick={toggleTheme}
            aria-label={
              settings.theme === "dark"
                ? "ライトモードに切り替え"
                : "ダークモードに切り替え"
            }
            title={
              settings.theme === "dark" ? "ライトモード" : "ダークモード"
            }
          >
            <span className="theme-switch-icon sun" aria-hidden>
              <IconSun size={12} />
            </span>
            <span className="theme-switch-icon moon" aria-hidden>
              <IconMoon size={12} />
            </span>
            <span className="theme-switch-knob" aria-hidden />
          </button>
        </div>
      </header>

      <div className="content">
        {/* Keep views mounted so in-flight work (esp. training) survives layout changes */}
        <div
          className="tab-panel"
          hidden={tab !== "speaker"}
          aria-hidden={tab !== "speaker"}
        >
          <SpeakerView
            speakers={speakers}
            onSpeakersChanged={refreshSpeakers}
            isV4={isIrodoriV4(settings)}
          />
        </div>
        <div
          className="tab-panel"
          hidden={tab !== "train"}
          aria-hidden={tab !== "train"}
        >
          <TrainView
            settings={settings}
            onSpeakersChanged={refreshSpeakers}
            onRunningChange={handleTrainingChange}
            onSettingsChange={setSettings}
          />
        </div>
        <div
          className="tab-panel"
          hidden={tab !== "generate"}
          aria-hidden={tab !== "generate"}
        >
          <GenerateView
            speakers={speakers}
            settings={settings}
            project={activeProject}
            openProjects={openProjects}
            projectNameDraft={projectNameDraft}
            onProjectChange={handleProjectChange}
            onOpenProjectsChange={setOpenProjects}
            onActiveProjectChange={setActiveProjectName}
            onProjectNameDraft={setProjectNameDraft}
          />
        </div>
        <div
          className="tab-panel"
          hidden={tab !== "dictionary"}
          aria-hidden={tab !== "dictionary"}
        >
          <DictionaryView />
        </div>
        <div
          className="tab-panel"
          hidden={tab !== "settings"}
          aria-hidden={tab !== "settings"}
        >
          <SettingsView
            settings={settings}
            validation={validation}
            firstSetup={setupIncomplete}
            onSaved={async (s) => {
              setSettings(s);
              const v = await invoke<PathValidation>("validate_paths");
              setValidation(v);
              if (v.irodoriRootOk) setSetupIncomplete(false);
              refreshSpeakers();
            }}
            onValidate={refreshValidation}
          />
        </div>
      </div>
    </div>
    </SpeakerSortProvider>
  );
}

export default App;
