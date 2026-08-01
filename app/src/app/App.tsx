import { useMemo } from "react";
import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "./router";
import { GameProvider } from "../state/GameProvider";
import type { SavePort } from "../application/ports/SavePort";
import type { ReliabilityPort } from "../application/ports/ReliabilityPort";
import { ReliabilityProvider, useReliability } from "../state/ReliabilityProvider";
import { FirstRunPage } from "../pages/FirstRunPage";

function ReliabilityExperience({ savePort, millisecondsPerGameDay }: { savePort: SavePort; millisecondsPerGameDay?: number }) {
  const { activeSaveId, loading } = useReliability();
  const router = useMemo(createAppRouter, []);
  if (loading) return <main className="page"><p role="status">正在检查本地存档…</p></main>;
  if (!activeSaveId) return <FirstRunPage />;
  return <GameProvider savePort={savePort} saveId={activeSaveId} millisecondsPerGameDay={millisecondsPerGameDay}><RouterProvider router={router} /></GameProvider>;
}

export function App({ savePort, reliabilityPort, millisecondsPerGameDay }: { savePort: SavePort; reliabilityPort?: ReliabilityPort; millisecondsPerGameDay?: number }) {
  const legacyRouter = useMemo(createAppRouter, []);
  if (!reliabilityPort) {
    return <GameProvider savePort={savePort} millisecondsPerGameDay={millisecondsPerGameDay}><RouterProvider router={legacyRouter} /></GameProvider>;
  }
  return <ReliabilityProvider port={reliabilityPort}><ReliabilityExperience savePort={savePort} millisecondsPerGameDay={millisecondsPerGameDay} /></ReliabilityProvider>;
}
