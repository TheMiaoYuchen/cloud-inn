import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createRuntimeSavePort } from "./runtimeSavePort";
import "./styles.css";

const savePort = createRuntimeSavePort("__TAURI_INTERNALS__" in window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App savePort={savePort} />
  </StrictMode>,
);
