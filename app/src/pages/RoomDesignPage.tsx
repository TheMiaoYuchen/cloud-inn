import { useState } from "react";
import { prototypeConfig } from "../domain/config/prototypeConfig";
import { evaluateRoom } from "../domain/room/evaluateRoom";
import { useGame } from "../state/GameProvider";
import { FloorPlanningPage } from "./FloorPlanningPage";

export function RoomDesignPage() {
  const { state, loading, error, commands, draft, setDraftName, setDraftCells, setActiveZone, setTool, applyDraftCell, applyDraftRectangle } = useGame();
  const [rectangleStart, setRectangleStart] = useState<{ x: number; y: number } | null>(null);
  if (loading) return <main><p>加载中…</p></main>;
  if (!state) return <main>{error && <p role="alert">{error}</p>}</main>;
  if (state.phase !== "design") return <FloorPlanningPage />;
  const metrics = (() => { try { return evaluateRoom(draft.cells, prototypeConfig.roomColumns, prototypeConfig.roomRows); } catch { return null; } })();
  const preset = () => {
    setDraftName("云岫商务房");
    setDraftCells(Array.from({ length: 96 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), zone: Math.floor(i / 8) < 8 ? "bedroom" : "bathroom" })));
  };
  const selectTool = (tool: typeof draft.tool) => { setTool(tool); setRectangleStart(null); };
  const editCell = (x: number, y: number) => {
    if (draft.tool !== "rectangle") return applyDraftCell(x, y);
    if (!rectangleStart) return setRectangleStart({ x, y });
    applyDraftRectangle(rectangleStart.x, rectangleStart.y, x, y);
    setRectangleStart(null);
  };
  return <main className="page">
    <h1>设计你的第一间客房</h1>
    <button aria-label="云岫商务房" onClick={preset}>载入24㎡示例户型</button>
    <div>
      <button aria-pressed={draft.activeZone === "bedroom"} onClick={() => setActiveZone("bedroom")}>卧室</button>
      <button aria-pressed={draft.activeZone === "bathroom"} onClick={() => setActiveZone("bathroom")}>卫浴</button>
      <button aria-pressed={draft.tool === "paint"} onClick={() => selectTool("paint")}>画笔</button>
      <button aria-pressed={draft.tool === "erase"} onClick={() => selectTool("erase")}>橡皮</button>
      <button aria-pressed={draft.tool === "rectangle"} onClick={() => selectTool("rectangle")}>矩形</button>
    </div>
    <input aria-label="房型名称" value={draft.name} onChange={(event) => setDraftName(event.target.value)} />
    <div className="grid" style={{ gridTemplateColumns: "repeat(8,1fr)" }}>
      {Array.from({ length: 96 }, (_, i) => {
        const x = i % 8, y = Math.floor(i / 8), cell = draft.cells.find((candidate) => candidate.x === x && candidate.y === y);
        return <button key={`${x}-${y}`} aria-label={`格子 ${x},${y}`} aria-pressed={Boolean(cell)} data-zone={cell?.zone} className={cell ? "cell on" : "cell"} onClick={() => editCell(x, y)} />;
      })}
    </div>
    {metrics ? <p>面积 {metrics.areaSquareMeters}㎡ · 造价 ¥{metrics.buildCostCents / 100} · 建议房价 ¥{metrics.suggestedRateCents / 100} · 适配度 {metrics.businessFitBps / 100}%</p> : <p role="alert">草图暂不可评估</p>}
    <button aria-label="保存并进入楼层" onClick={() => commands.saveRoomBlueprint(draft.name, draft.cells)}>保存房型</button>
    {error && <p role="alert">{error}</p>}
  </main>;
}
