import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createRuntimeReliabilityPort } from "./runtimeReliabilityPort";
import { createRuntimeSavePort } from "./runtimeSavePort";
import { e2eDayMilliseconds } from "./e2eClockConfig";
import "./styles.css";

const hasTauri = "__TAURI_INTERNALS__" in window;
const savePort = createRuntimeSavePort(hasTauri);
const reliabilityPort = createRuntimeReliabilityPort(hasTauri);
const testDayMs = e2eDayMilliseconds(
  import.meta.env.DEV && import.meta.env.VITE_CLOUD_INN_E2E === "true",
  window.localStorage.getItem("cloud-inn:e2e-day-ms"),
);

async function mount(): Promise<void> {
  if (hasTauri) {
    try {
      const [{ listen }, { invoke }] = await Promise.all([
        import("@tauri-apps/api/event"),
        import("@tauri-apps/api/core"),
      ]);
      await listen("cloudinn-close-requested", async () => {
        let pending: Promise<unknown> = Promise.resolve();
        window.dispatchEvent(new CustomEvent("cloudinn:flush-requested", {
          detail: { settle(task: Promise<unknown>) { pending = task; } },
        }));
        await Promise.race([
          pending.catch(() => undefined),
          new Promise((resolve) => window.setTimeout(resolve, 5_000)),
        ]);
        try {
          await invoke("complete_close_handshake");
        } catch {
          // A second native close request may already have destroyed the window.
        }
      });
    } catch {
      // Keep the app usable if the native event bridge is unavailable at startup.
    }
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        savePort={savePort}
        reliabilityPort={reliabilityPort}
        millisecondsPerGameDay={testDayMs}
      />
    </StrictMode>,
  );
}

void mount();
