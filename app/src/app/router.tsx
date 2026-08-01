import { createHashRouter, Navigate, useSearchParams } from "react-router-dom";
import type { ReactNode } from "react";
import { CanvasPage } from "../pages/CanvasPage";
import { HotelOverviewPage } from "../pages/HotelOverviewPage";
import { AppShell } from "./AppShell";
import { RoomDesignPage } from "../pages/RoomDesignPage";
import { FloorPlanningPage } from "../pages/FloorPlanningPage";
import { OperationsPage } from "../pages/OperationsPage";
import { RoomVariantPage } from "../pages/RoomVariantPage";
import { BuildingOverviewPage } from "../pages/BuildingOverviewPage";
import { PublicSpaceDesignPage } from "../pages/PublicSpaceDesignPage";
import { ContentCompendiumPage } from "../pages/ContentCompendiumPage";
import { useGame } from "../state/GameProvider";
import { SaveManagerPage } from "../pages/SaveManagerPage";
import { DesignStudioPage } from "../pages/DesignStudioPage";
import { DiagnosticsPage } from "../pages/DiagnosticsPage";

function LegacyDesignRoute({ children }: { children: ReactNode }) {
  const { state, loading } = useGame();
  if (loading) return <main className="page"><p role="status">正在加载存档…</p></main>;
  if (state?.phase4) return <Navigate to="/building" replace />;
  return children;
}

function Phase4Route({ children }: { children: ReactNode }) {
  const { state, loading } = useGame();
  if (loading) return <main className="page"><p role="status">正在加载存档…</p></main>;
  if (!state?.phase4) return <Navigate to="/" replace />;
  return children;
}

function BuildingOverviewRoute() {
  const [searchParams] = useSearchParams();
  return <BuildingOverviewPage requestedFloorId={searchParams.get("floorId")} />;
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
        { path: "building", element: <BuildingOverviewRoute /> },
        { path: "tower", element: <Navigate to="/building" replace /> },
        { path: "public-spaces/design", element: <Phase4Route><PublicSpaceDesignPage /></Phase4Route> },
        { path: "compendium", element: <Phase4Route><ContentCompendiumPage /></Phase4Route> },
        { path: "operations", element: <OperationsPage /> },
        { path: "saves", element: <SaveManagerPage /> },
        { path: "studio", element: <DesignStudioPage /> },
        { path: "diagnostics", element: <DiagnosticsPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}
