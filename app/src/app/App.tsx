import { useMemo } from "react";
import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "./router";
import { GameProvider } from "../state/GameProvider";
import type { SavePort } from "../application/ports/SavePort";

export function App({ savePort }: { savePort: SavePort }) {
  const router = useMemo(createAppRouter, []);
  return <GameProvider savePort={savePort}><RouterProvider router={router} /></GameProvider>;
}
