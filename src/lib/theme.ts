import { useEffect } from "react";
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
