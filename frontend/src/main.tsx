import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";

// Right-click context menus and text drag are desktop-app noise; keep them off outside inputs.
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (e) => {
    const el = e.target as HTMLElement | null;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) e.preventDefault();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
