import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
