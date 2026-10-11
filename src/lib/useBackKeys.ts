import { useEffect } from "react";
import { useStash } from "../store/useStash";

/**
 * Esc, or the key that opened the screen, returns to the list. Bubble phase on
 * purpose: the shortcut recorder and the folder-rename field consume their own
 * Escape first (capture / stopPropagation), so cancelling those does not also
 * leave the screen.
 */
export function useBackKeys(opener: (e: KeyboardEvent) => boolean) {
  const setView = useStash((s) => s.setView);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || opener(e)) {
        e.preventDefault();
        setView("list");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [opener, setView]);
}

export const isSettingsKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key === ",";
export const isHelpKey = (e: KeyboardEvent) =>
  e.key === "F1" || ((e.ctrlKey || e.metaKey) && e.key === "/");
