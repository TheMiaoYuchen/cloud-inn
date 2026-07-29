import { createHashRouter, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { CanvasPage } from "../pages/CanvasPage";
import { HotelOverviewPage } from "../pages/HotelOverviewPage";
import { AppShell } from "./AppShell";
import { RoomDesignPage } from "../pages/RoomDesignPage";
import { FloorPlanningPage } from "../pages/FloorPlanningPage";
import { OperationsPage } from "../pages/OperationsPage";
import { RoomVariantPage } from "../pages/RoomVariantPage";
import { BuildingOverviewPage } from "../pages/BuildingOverviewPage";
import { useGame } from "../state/GameProvider";

function LegacyDesignRoute({ children }: { children: ReactNode }) {
  const { state, loading } = useGame();
  if (loading) return <main className="page"><p role="status">正在加载存档…</p></main>;
  if (state?.phase4) return <Navigate to="/building" replace />;
  return children;
}

export function createAppRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <HotelOverviewPage /> },
        { path: "canvas", element: <CanvasPage /> },
        { path: "design", element: <LegacyDesignRoute><RoomDesignPage /></LegacyDesignRoute> },
        { path: "design/variants", element: <LegacyDesignRoute><RoomVariantPage /></LegacyDesignRoute> },
        { path: "floor-plan", element: <LegacyDesignRoute><FloorPlanningPage /></LegacyDesignRoute> },
        { path: "floor", element: <LegacyDesignRoute><FloorPlanningPage /></LegacyDesignRoute> },
        { path: "building", element: <BuildingOverviewPage /> },
        { path: "tower", element: <Navigate to="/building" replace /> },
        { path: "operations", element: <OperationsPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}
