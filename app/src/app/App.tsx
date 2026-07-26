import { useMemo } from "react";
import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "./router";
import { GameProvider } from "../state/GameProvider";

export function App() {
  const router = useMemo(createAppRouter, []);
  return <GameProvider><RouterProvider router={router} /></GameProvider>;
}
