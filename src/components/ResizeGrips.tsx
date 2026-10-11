import type { ResizeDirection } from "../lib/ipc";

/**
 * Both window kinds are undecorated, so the OS draws no resize border. These
 * invisible strips along each edge supply one. `start` is the window's own
 * resize call -- the panel's arms its hide-on-blur guard first, a sticky's
 * does not. Both need `core:window:allow-start-resize-dragging`.
 */
export function ResizeGrips({ start }: { start: (dir: ResizeDirection) => void }) {
  const grip = (dir: ResizeDirection, className: string, cursor: string) => (
    <div
      key={dir}
      onMouseDown={(e) => {
        // Left button only, and never let the drag-region handler also fire.
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        start(dir);
      }}
      className={`absolute z-50 ${className}`}
      style={{ cursor }}
    />
  );

  return (
    <>
      {grip("North", "left-3 right-3 top-0 h-1.5", "ns-resize")}
      {grip("South", "bottom-0 left-3 right-3 h-1.5", "ns-resize")}
      {grip("West", "bottom-3 left-0 top-3 w-1.5", "ew-resize")}
      {grip("East", "bottom-3 right-0 top-3 w-1.5", "ew-resize")}
      {grip("NorthWest", "left-0 top-0 h-3 w-3", "nwse-resize")}
      {grip("NorthEast", "right-0 top-0 h-3 w-3", "nesw-resize")}
      {grip("SouthWest", "bottom-0 left-0 h-3 w-3", "nesw-resize")}
      {grip("SouthEast", "bottom-0 right-0 h-3.5 w-3.5", "nwse-resize")}
    </>
  );
}
