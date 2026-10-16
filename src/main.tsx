import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { preloadNoteEditor } from "./components/LazyNoteEditor";
import { StickyHost } from "./components/StickyWindow";
import "./styles.css";

// One bundle, two kinds of window. A sticky is opened by Rust at
// `index.html?sticky=<id>` -- or at a bare `?sticky` for the spare kept ready
// in the background, which is told its item later -- and renders only its
// card. None of the panel's store, hotkeys or hide-on-blur behaviour comes
// with it.
const params = new URLSearchParams(window.location.search);
const isSticky = params.has("sticky");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isSticky ? <StickyHost initialId={params.get("sticky") || null} /> : <App />}
  </React.StrictMode>,
);

// The note editor is its own chunk, fetched once the window has painted and
// gone quiet, so it is warm by the time a note opens -- including in the spare
// sticky, which usually becomes a blank note -- without being in the way of
// the panel's or a card's first paint.
requestIdleCallback(preloadNoteEditor, { timeout: 2000 });
