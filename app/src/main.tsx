import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createRuntimeSavePort } from "./runtimeSavePort";
import "./styles.css";

const savePort = createRuntimeSavePort("__TAURI_INTERNALS__" in window);
const testDayMs = Number(window.localStorage.getItem("cloud-inn:e2e-day-ms"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App savePort={savePort} millisecondsPerGameDay={Number.isSafeInteger(testDayMs) && testDayMs > 0 ? testDayMs : undefined} />
  </StrictMode>,
);
