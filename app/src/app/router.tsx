import { createHashRouter, Navigate } from "react-router-dom";
import { CanvasPage } from "../pages/CanvasPage";
import { HotelOverviewPage } from "../pages/HotelOverviewPage";
import { AppShell } from "./AppShell";
import { RoomDesignPage } from "../pages/RoomDesignPage";
import { FloorPlanningPage } from "../pages/FloorPlanningPage";
import { OperationsPage } from "../pages/OperationsPage";
import { RoomVariantPage } from "../pages/RoomVariantPage";
import { BuildingOverviewPage } from "../pages/BuildingOverviewPage";

export function createAppRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <HotelOverviewPage /> },
        { path: "canvas", element: <CanvasPage /> },
        { path: "design", element: <RoomDesignPage /> },
        { path: "design/variants", element: <RoomVariantPage /> },
        { path: "floor-plan", element: <FloorPlanningPage /> },
        { path: "floor", element: <FloorPlanningPage /> },
        { path: "building", element: <BuildingOverviewPage /> },
        { path: "tower", element: <Navigate to="/building" replace /> },
        { path: "operations", element: <OperationsPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}
