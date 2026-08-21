export type AccentPalette = {
  id: string;
  label: string;
  accent: string;
  accentSoft: string;
  accentDeep: string;
  accentGradA: string;
  accentGradB: string;
};

export const DEFAULT_ACCENT_LIGHT = "purple";
export const DEFAULT_ACCENT_DARK = "teal";

/** Light-mode accents. Default is deep purple; pink is the former default. */
export const LIGHT_ACCENTS: AccentPalette[] = [
  {
    id: "purple",
    label: "濃い紫",
    accent: "#5b21b6",
    accentSoft: "rgba(91, 33, 182, 0.12)",
    accentDeep: "#4c1d95",
    accentGradA: "#7c3aed",
    accentGradB: "#5b21b6",
  },
  {
    id: "pink",
    label: "ピンク",
    accent: "#ff1493",
    accentSoft: "rgba(255, 20, 147, 0.12)",
    accentDeep: "#e01080",
    accentGradA: "#ff4eb0",
    accentGradB: "#ff1493",
  },
  {
    id: "indigo",
    label: "藍",
    accent: "#3730a3",
    accentSoft: "rgba(55, 48, 163, 0.12)",
    accentDeep: "#312e81",
    accentGradA: "#4f46e5",
    accentGradB: "#3730a3",
  },
  {
    id: "crimson",
    label: "紅",
    accent: "#be123c",
    accentSoft: "rgba(190, 18, 60, 0.12)",
    accentDeep: "#9f1239",
    accentGradA: "#e11d48",
    accentGradB: "#be123c",
  },
  {
    id: "teal",
    label: "青緑",
    accent: "#0f766e",
    accentSoft: "rgba(15, 118, 110, 0.12)",
    accentDeep: "#115e59",
    accentGradA: "#14b8a6",
    accentGradB: "#0f766e",
  },
  {
    id: "amber",
    label: "琥珀",
    accent: "#c2410c",
    accentSoft: "rgba(194, 65, 12, 0.12)",
    accentDeep: "#9a3412",
    accentGradA: "#ea580c",
    accentGradB: "#c2410c",
  },
  {
    id: "sky",
    label: "空",
    accent: "#0369a1",
    accentSoft: "rgba(3, 105, 161, 0.12)",
    accentDeep: "#075985",
    accentGradA: "#0284c7",
    accentGradB: "#0369a1",
  },
  {
    id: "forest",
    label: "深緑",
    accent: "#166534",
    accentSoft: "rgba(22, 101, 52, 0.12)",
    accentDeep: "#14532d",
    accentGradA: "#16a34a",
    accentGradB: "#166534",
  },
];

/** Dark-mode accents. Default is bright teal; orange is the former default. */
export const DARK_ACCENTS: AccentPalette[] = [
  {
    id: "teal",
    label: "明るい青緑",
    accent: "#2ee6c8",
    accentSoft: "rgba(46, 230, 200, 0.18)",
    accentDeep: "#22cbb0",
    accentGradA: "#5af0d6",
    accentGradB: "#20d4b4",
  },
  {
    id: "orange",
    label: "オレンジ",
    accent: "#e0703c",
    accentSoft: "rgba(224, 138, 60, 0.18)",
    accentDeep: "#d05d2c",
    accentGradA: "#e96f4d",
    accentGradB: "#d0582c",
  },
  {
    id: "lavender",
    label: "ラベンダー",
    accent: "#c4b5fd",
    accentSoft: "rgba(196, 181, 253, 0.18)",
    accentDeep: "#a78bfa",
    accentGradA: "#ddd6fe",
    accentGradB: "#a78bfa",
  },
  {
    id: "gold",
    label: "ゴールド",
    accent: "#fbbf24",
    accentSoft: "rgba(251, 191, 36, 0.18)",
    accentDeep: "#f59e0b",
    accentGradA: "#fcd34d",
    accentGradB: "#f59e0b",
  },
  {
    id: "rose",
    label: "ローズ",
    accent: "#fb7185",
    accentSoft: "rgba(251, 113, 133, 0.18)",
    accentDeep: "#f43f5e",
    accentGradA: "#fda4af",
    accentGradB: "#f43f5e",
  },
  {
    id: "lime",
    label: "ライム",
    accent: "#a3e635",
    accentSoft: "rgba(163, 230, 53, 0.18)",
    accentDeep: "#84cc16",
    accentGradA: "#bef264",
    accentGradB: "#84cc16",
  },
  {
    id: "sky",
    label: "スカイ",
    accent: "#38bdf8",
    accentSoft: "rgba(56, 189, 248, 0.18)",
    accentDeep: "#0ea5e9",
    accentGradA: "#7dd3fc",
    accentGradB: "#0ea5e9",
  },
  {
    id: "coral",
    label: "コーラル",
    accent: "#ff7a6b",
    accentSoft: "rgba(255, 122, 107, 0.18)",
    accentDeep: "#f25c4e",
    accentGradA: "#ff9a8c",
    accentGradB: "#f25c4e",
  },
];

const LIGHT_IDS = new Set(LIGHT_ACCENTS.map((p) => p.id));
const DARK_IDS = new Set(DARK_ACCENTS.map((p) => p.id));

export function normalizeAccentLight(id: string | undefined | null): string {
  if (id && LIGHT_IDS.has(id)) return id;
  return DEFAULT_ACCENT_LIGHT;
}

export function normalizeAccentDark(id: string | undefined | null): string {
  if (id && DARK_IDS.has(id)) return id;
  return DEFAULT_ACCENT_DARK;
}

export function lightAccentOf(id: string | undefined | null): AccentPalette {
  const nid = normalizeAccentLight(id);
  return LIGHT_ACCENTS.find((p) => p.id === nid) ?? LIGHT_ACCENTS[0];
}

export function darkAccentOf(id: string | undefined | null): AccentPalette {
  const nid = normalizeAccentDark(id);
  return DARK_ACCENTS.find((p) => p.id === nid) ?? DARK_ACCENTS[0];
}

function applyPalette(root: HTMLElement, palette: AccentPalette) {
  root.style.setProperty("--accent", palette.accent);
  root.style.setProperty("--accent-soft", palette.accentSoft);
  root.style.setProperty("--accent-deep", palette.accentDeep);
  root.style.setProperty("--accent-grad-a", palette.accentGradA);
  root.style.setProperty("--accent-grad-b", palette.accentGradB);
}

/** Apply theme + accent CSS variables to <html>. */
export function applyAppearance(
  theme: string | undefined | null,
  accentLight: string | undefined | null,
  accentDark: string | undefined | null,
) {
  const root = document.documentElement;
  const mode = theme === "dark" ? "dark" : "light";
  root.dataset.theme = mode;
  applyPalette(
    root,
    mode === "dark" ? darkAccentOf(accentDark) : lightAccentOf(accentLight),
  );
}
