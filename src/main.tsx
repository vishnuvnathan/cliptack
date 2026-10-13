import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StickyWindow } from "./components/StickyWindow";
import "./styles.css";

// One bundle, two kinds of window. A sticky is opened by Rust at
// `index.html?sticky=<id>` and renders only its card -- none of the panel's
// store, hotkeys or hide-on-blur behaviour comes with it.
const stickyId = new URLSearchParams(window.location.search).get("sticky");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {stickyId ? <StickyWindow id={stickyId} /> : <App />}
  </React.StrictMode>,
);
