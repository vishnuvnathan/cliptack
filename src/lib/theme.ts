import { useEffect, type CSSProperties } from "react";
import type { ThemeMode } from "./types";

/** Matches `DEFAULT_ACCENT` in settings.rs. */
export const DEFAULT_ACCENT = "#7aa2f7";

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Blue", hex: "#7aa2f7" },
  { name: "Violet", hex: "#a78bfa" },
  { name: "Pink", hex: "#f472b6" },
  { name: "Orange", hex: "#fb923c" },
  { name: "Green", hex: "#4ade80" },
  { name: "Teal", hex: "#2dd4bf" },
];

export function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The accent is used as text and as a fill. A pastel that reads well on the
 * dark panel is nearly invisible as text on the light one, so the light theme
 * uses a darkened copy of whatever was picked -- same hue, usable contrast.
 */
function accentFor(hex: string, mode: "dark" | "light"): string {
  const [r, g, b] = rgbOf(isHex(hex) ? hex : DEFAULT_ACCENT);
  const k = mode === "light" ? 0.68 : 1;
  return `${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)}`;
}

/**
 * Paper colours for stickies. "default" is no paper: the card follows the app
 * theme like before. The rest are light papers whatever the theme -- that is
 * what reads as a sticky note -- so each one swaps in dark ink as well as a
 * background. They override the same tokens styles.css defines, which is why
 * nothing inside the card needs to know which paper it is on.
 *
 * Names match `COLORS` in sticky.rs.
 */
export type StickyPaper = {
  name: string;
  label: string;
  /** For the picker's swatch. */
  swatch: string;
  /** Panel, title strip, border/hover tint, and the band and link colour. */
  panel?: string;
  panelalt?: string;
  edge?: string;
  accent?: string;
};

export const STICKY_PAPERS: StickyPaper[] = [
  { name: "default", label: "Theme", swatch: "rgb(var(--c-panel))" },
  { name: "yellow", label: "Yellow", swatch: "#fdf0a6", panel: "253 240 166", panelalt: "247 229 135", edge: "226 205 110", accent: "146 108 0" },
  { name: "pink", label: "Pink", swatch: "#fcd6e4", panel: "252 214 228", panelalt: "247 197 215", edge: "230 170 194", accent: "190 24 93" },
  { name: "green", label: "Green", swatch: "#cff0ca", panel: "207 240 202", panelalt: "188 230 182", edge: "158 208 152", accent: "21 128 61" },
  { name: "blue", label: "Blue", swatch: "#cae1fc", panel: "202 225 252", panelalt: "182 211 247", edge: "150 186 230", accent: "29 78 216" },
  { name: "purple", label: "Purple", swatch: "#e2d6fc", panel: "226 214 252", panelalt: "212 196 247", edge: "186 166 230", accent: "109 40 217" },
  { name: "orange", label: "Orange", swatch: "#fedebe", panel: "254 222 190", panelalt: "250 207 166", edge: "232 180 134", accent: "194 65 12" },
];

export function paperFor(name: string): StickyPaper {
  return STICKY_PAPERS.find((p) => p.name === name) ?? STICKY_PAPERS[0];
}

/**
 * Inline custom properties for a card on `paper`. Empty for the default, so
 * the card inherits the theme's values from :root. The ink is the light
 * theme's greys, except zinc-800 -- the hover fill -- which is tinted to the
 * paper so a hovered button does not show a grey patch.
 */
export function paperStyle(paper: StickyPaper): CSSProperties {
  if (!paper.panel) return {};
  return {
    colorScheme: "light",
    "--c-panel": paper.panel,
    "--c-panelalt": paper.panelalt,
    "--c-edge": paper.edge,
    "--c-accent": paper.accent,
    "--c-onaccent": "255 255 255",
    "--c-zinc-100": "24 24 27",
    "--c-zinc-200": "39 39 42",
    "--c-zinc-300": "52 52 58",
    "--c-zinc-400": "70 70 78",
    "--c-zinc-500": "88 88 96",
    "--c-zinc-600": "112 112 120",
    "--c-zinc-700": "140 140 148",
    "--c-zinc-800": paper.edge,
  } as CSSProperties;
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): "dark" | "light" {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

function apply(mode: "dark" | "light", accent: string) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.setProperty("--c-accent", accentFor(accent, mode));
}

/**
 * Keeps <html data-theme> and --c-accent in step with the settings. For
 * "system" it also follows the OS preference live, so flipping Windows between
 * light and dark restyles an already-open panel.
 */
export function useTheme(mode: ThemeMode | undefined, accent: string | undefined) {
  useEffect(() => {
    if (!mode || !accent) return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const run = () => apply(resolveTheme(mode, query.matches), accent);
    run();

    if (mode !== "system") return;
    query.addEventListener("change", run);
    return () => query.removeEventListener("change", run);
  }, [mode, accent]);
}
