/** App-owned palettes, with paired schemes so System mode can follow macOS. */
export interface ThemeColors {
  bg: string;
  side: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
}

export const COLOR_THEMES = [
  {
    id: "classic",
    name: "Classic",
    description: "Clean neutrals and blue",
    light: {
      bg: "#ffffff",
      side: "#f6f6f8",
      text: "#1d1f26",
      muted: "#6b7080",
      faint: "#a0a4b0",
      border: "#e4e5ea",
      accent: "#2563eb",
    },
    dark: {
      bg: "#1e1f24",
      side: "#18191d",
      text: "#e4e5ea",
      muted: "#9a9fad",
      faint: "#6b7080",
      border: "#2d2f36",
      accent: "#8eb3ff",
    },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Warm ivory and ochre",
    light: {
      bg: "#fffaf0",
      side: "#f3ebdc",
      text: "#362f27",
      muted: "#75634e",
      faint: "#8a7965",
      border: "#ded2bd",
      accent: "#9b521e",
    },
    dark: {
      bg: "#26221b",
      side: "#1e1b16",
      text: "#ede5d5",
      muted: "#c2b39b",
      faint: "#93846b",
      border: "#443c2e",
      accent: "#edbd83",
    },
  },
  {
    id: "forest",
    name: "Forest",
    description: "Soft sage and evergreen",
    light: {
      bg: "#f5faf5",
      side: "#e8f1e8",
      text: "#203b2a",
      muted: "#526b59",
      faint: "#708274",
      border: "#cddfce",
      accent: "#256440",
    },
    dark: {
      bg: "#18251e",
      side: "#121d17",
      text: "#dfede2",
      muted: "#a2bca9",
      faint: "#718a79",
      border: "#344d3d",
      accent: "#8cd5a3",
    },
  },
  {
    id: "ocean",
    name: "Ocean",
    description: "Cool mist and deep teal",
    light: {
      bg: "#f4f9fc",
      side: "#e6eff6",
      text: "#18394e",
      muted: "#506b7e",
      faint: "#728b9d",
      border: "#ccdce7",
      accent: "#176482",
    },
    dark: {
      bg: "#16232f",
      side: "#101b25",
      text: "#dfeef7",
      muted: "#9cb8cb",
      faint: "#6e8d9f",
      border: "#304a5e",
      accent: "#85cbed",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    description: "Pale lavender and plum",
    light: {
      bg: "#faf6fc",
      side: "#f0e9f5",
      text: "#3a2d47",
      muted: "#72607f",
      faint: "#8a7898",
      border: "#dfd2e8",
      accent: "#7a4a91",
    },
    dark: {
      bg: "#261f30",
      side: "#1e1826",
      text: "#eee4f6",
      muted: "#c3aecf",
      faint: "#927e9e",
      border: "#493954",
      accent: "#d9b0ed",
    },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  description: string;
  light: ThemeColors;
  dark: ThemeColors;
}[];

export type ColorTheme = (typeof COLOR_THEMES)[number]["id"];
export type Accent = "theme" | "blue" | "green" | "violet" | "amber";
export const ACCENT_COLORS = {
  light: { blue: "#2563eb", green: "#15803d", violet: "#7c3aed", amber: "#b45309" },
  dark: { blue: "#8eb3ff", green: "#7fcea4", violet: "#c4acff", amber: "#f5bf72" },
} as const;

export const isColorTheme = (value: unknown): value is ColorTheme => COLOR_THEMES.some((theme) => theme.id === value);

export function applyColorTheme(root: HTMLElement, name: ColorTheme, dark: boolean, accent: Accent) {
  const palette = COLOR_THEMES.find((theme) => theme.id === name) ?? COLOR_THEMES[0];
  const colors = dark ? palette.dark : palette.light;
  const accentColor = accent === "theme" ? colors.accent : ACCENT_COLORS[dark ? "dark" : "light"][accent];
  root.dataset.colorTheme = palette.id;
  const values = {
    bg: colors.bg,
    "bg-side": colors.side,
    fg: colors.text,
    muted: colors.muted,
    faint: colors.faint,
    border: colors.border,
    accent: accentColor,
    "on-accent": dark ? colors.bg : "#ffffff",
    "bg-hover": dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)",
    "bg-active": `color-mix(in srgb, ${accentColor} ${dark ? 20 : 12}%, transparent)`,
    danger: dark ? "#ff6b61" : "#d6453d",
    "warn-bg": dark ? "#3d3420" : "#fff4d6",
    "err-bg": dark ? "#43231f" : "#fde4e2",
    success: dark ? "#8bd5ad" : "#23754e",
    review: dark ? "#edbd70" : "#956114",
    shadow: dark
      ? "0 8px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)"
      : "0 8px 28px rgba(0, 0, 0, 0.14), 0 0 0 1px rgba(0, 0, 0, 0.06)",
  };
  for (const [key, value] of Object.entries(values)) root.style.setProperty(`--${key}`, value);
}
