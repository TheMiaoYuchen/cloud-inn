import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createRuntimeSavePort } from "./runtimeSavePort";
import { e2eDayMilliseconds } from "./e2eClockConfig";
import "./styles.css";

const savePort = createRuntimeSavePort("__TAURI_INTERNALS__" in window);
const testDayMs = e2eDayMilliseconds(
  import.meta.env.DEV && import.meta.env.VITE_CLOUD_INN_E2E === "true",
  window.localStorage.getItem("cloud-inn:e2e-day-ms"),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App savePort={savePort} millisecondsPerGameDay={testDayMs} />
  </StrictMode>,
);
