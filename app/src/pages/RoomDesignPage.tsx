import { useEffect, useState } from "react";

import { RoomPropertyPanel } from "../components/design/RoomPropertyPanel";
import {
  RoomToolRail,
  type EditorTool,
} from "../components/design/RoomToolRail";
import { VariantFilmstrip } from "../components/design/VariantFilmstrip";
import { prototypeConfig } from "../domain/config/prototypeConfig";
import {
  CONTEMPORARY_ORIENTAL,
  STYLE_PRESETS,
} from "../domain/design/stylePresets";
import {
  addDoor,
  addWall,
  addWindow,
  createRoomDraft,
  eraseRoomCell,
  paintRoomCell,
  selectionBounds,
  type RoomDraft,
  type RoomSide,
} from "../domain/room/editRoom";
import { evaluateRoom } from "../domain/room/evaluateRoom";
import { useGame } from "../state/GameProvider";
import { FloorPlanningPage } from "./FloorPlanningPage";

const EMPTY_DRAFT = createRoomDraft(
  [],
  prototypeConfig.roomColumns,
  prototypeConfig.roomRows,
);

function openingAt(room: RoomDraft, x: number, y: number) {
  if (room.walls.some((opening) => opening.x === x && opening.y === y)) {
    return "wall";
  }
  if (room.doors.some((opening) => opening.x === x && opening.y === y)) {
    return "door";
  }
  if (room.windows.some((opening) => opening.x === x && opening.y === y)) {
    return "window";
  }
  return undefined;
}

export function RoomDesignPage() {
  const { state, loading, error } = useGame();
  if (loading) return <main><p>加载中…</p></main>;
  if (!state) return <main>{error && <p role="alert">{error}</p>}</main>;
  if (state.phase !== "design") return <FloorPlanningPage />;
  return <RoomDesignEditor />;
}

function RoomDesignEditor() {
  const {
    state: loadedState,
    error,
    commands,
    draft,
    setDraftName,
    setDraftCells,
    setActiveZone,
  } = useGame();
  const state = loadedState!;
  const master = state.phase2?.roomMaster;
  const [room, setRoom] = useState<RoomDraft>(() => master
    ? {
        ...createRoomDraft(master.cells, master.columns, master.rows),
        ...structuredClone(master.openings),
      }
    : EMPTY_DRAFT);
  const [past, setPast] = useState<RoomDraft[]>([]);
  const [future, setFuture] = useState<RoomDraft[]>([]);
  const [rectangleStart, setRectangleStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState(
    CONTEMPORARY_ORIENTAL.id,
  );
  const [savedNotice, setSavedNotice] = useState(false);
  const [editorTool, setEditorTool] = useState<EditorTool>("paint");
  const [openingSide, setOpeningSide] = useState<RoomSide>("north");
  const [selectionStart, setSelectionStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(() => {
    if (!master) return;
    setDraftName(master.name);
    setDraftCells(structuredClone(master.cells));
  }, [master?.id]);

  const metrics = (() => {
    try {
      return evaluateRoom(
        room.cells,
        prototypeConfig.roomColumns,
        prototypeConfig.roomRows,
      );
    } catch {
      return null;
    }
  })();

  const commitEdit = (next: RoomDraft) => {
    setPast((items) => [...items, structuredClone(room)]);
    setFuture([]);
    setRoom(next);
    setDraftCells(structuredClone(next.cells));
    setEditorError(null);
  };

  const loadPreset = () => {
    const cells = Array.from({ length: 96 }, (_, index) => ({
      x: index % 8,
      y: Math.floor(index / 8),
      zone: Math.floor(index / 8) < 8
        ? ("bedroom" as const)
        : ("bathroom" as const),
    }));
    setDraftName("云岫商务房");
    commitEdit(createRoomDraft(cells, 8, 12));
  };

  const editCell = (x: number, y: number) => {
    try {
      if (editorTool === "select") {
        if (!selectionStart || selectionEnd) {
          setSelectionStart({ x, y });
          setSelectionEnd(null);
        } else {
          setSelectionEnd({ x, y });
        }
        return;
      }
      if (
        editorTool === "wall" ||
        editorTool === "door" ||
        editorTool === "window"
      ) {
        const opening = { x, y, side: openingSide };
        const next = editorTool === "wall"
          ? addWall(room, opening)
          : editorTool === "door"
            ? addDoor(room, opening)
            : addWindow(room, opening);
        commitEdit(next);
        return;
      }
      if (editorTool === "rectangle") {
        if (!rectangleStart) {
          setRectangleStart({ x, y });
          return;
        }
        let next = room;
        for (
          let cellY = Math.min(rectangleStart.y, y);
          cellY <= Math.max(rectangleStart.y, y);
          cellY += 1
        ) {
          for (
            let cellX = Math.min(rectangleStart.x, x);
            cellX <= Math.max(rectangleStart.x, x);
            cellX += 1
          ) {
            next = paintRoomCell(next, {
              x: cellX,
              y: cellY,
              zone: draft.activeZone,
            });
          }
        }
        setRectangleStart(null);
        commitEdit(next);
        return;
      }
      commitEdit(
        editorTool === "erase"
          ? eraseRoomCell(room, x, y)
          : paintRoomCell(room, { x, y, zone: draft.activeZone }),
      );
    } catch (caught) {
      setEditorError(caught instanceof Error ? caught.message : "编辑失败");
    }
  };

  const openings = {
    walls: room.walls,
    doors: room.doors,
    windows: room.windows,
  };
  const saveSeries = async () => {
    const saved = await commands.saveRoomSeries({
      id: "room-master-1",
      name: draft.name,
      cells: room.cells,
      openings,
      gene: STYLE_PRESETS.find((item) => item.id === selectedPreset)?.gene ??
        CONTEMPORARY_ORIENTAL.gene,
    });
    setSavedNotice(saved);
  };
  const variants = state.phase2?.roomVariants ?? [];
  const selectedBounds = selectionStart
    ? selectionBounds(
        room,
        selectionEnd ? [selectionStart, selectionEnd] : [selectionStart],
      )
    : null;
  const isSelected = (x: number, y: number) =>
    Boolean(
      selectionEnd &&
      selectedBounds &&
      x >= selectedBounds.x &&
      x < selectedBounds.x + selectedBounds.width &&
      y >= selectedBounds.y &&
      y < selectedBounds.y + selectedBounds.height,
    );
  const sides: Array<[RoomSide, string]> = [
    ["north", "北侧"],
    ["east", "东侧"],
    ["south", "南侧"],
    ["west", "西侧"],
  ];

  return <main className="page design-page">
    <header className="design-header"><div><p className="eyebrow">云岫酒店 · 设计工作台</p><h1>设计你的第一间客房</h1></div><button aria-label="云岫商务房" onClick={loadPreset}>载入24㎡示例户型</button></header>
    <div className="editor-layout">
      <RoomToolRail activeZone={draft.activeZone} tool={editorTool} onZone={setActiveZone} onTool={(tool) => { setEditorTool(tool); setRectangleStart(null); setSelectionStart(null); setSelectionEnd(null); setEditorError(null); }} />
      <section className="canvas-panel" aria-label="房型画布" role="region">
        <div className="canvas-toolbar"><span>1 格 = 0.25㎡</span><span>{editorTool === "select" && selectionStart && !selectionEnd ? "请选择区域的第二个角点" : rectangleStart ? "请选择第二个角点" : "点击格子开始绘制"}</span></div>
        {editorTool === "select" && selectionEnd && selectedBounds && <p role="status">已选择 {selectedBounds.width}×{selectedBounds.height}，共 {selectedBounds.width * selectedBounds.height} 格</p>}
        {(editorTool === "wall" || editorTool === "door" || editorTool === "window") && <div aria-label="开口方向">{sides.map(([side, label]) => <button key={side} aria-pressed={openingSide === side} onClick={() => setOpeningSide(side)}>{label}</button>)}</div>}
        <div className="grid design-grid" style={{ gridTemplateColumns: "repeat(8,1fr)" }}>{Array.from({ length: 96 }, (_, index) => { const x = index % 8; const y = Math.floor(index / 8); const cell = room.cells.find((item) => item.x === x && item.y === y); return <button key={`${x}-${y}`} aria-label={`格子 ${x},${y}`} aria-pressed={Boolean(cell)} data-zone={cell?.zone} data-opening={openingAt(room, x, y)} data-selected={isSelected(x, y) ? "true" : undefined} className={`${cell ? `cell on ${cell.zone}` : "cell"}${isSelected(x, y) ? " selected" : ""}`} onClick={() => editCell(x, y)} />; })}</div>
        <p className="canvas-note">拖拽或点击格子划分功能区；房间大小、材质与风格会共同影响造价和后续房价。</p>
      </section>
      <RoomPropertyPanel name={draft.name} metrics={metrics} presets={STYLE_PRESETS} selectedPreset={selectedPreset} onName={setDraftName} onPreset={(preset) => setSelectedPreset(preset.id)} />
    </div>
    <div className="editor-actions">
      <button aria-label="撤销" disabled={!past.length} onClick={() => { const previous = past[past.length - 1]; if (!previous) return; setFuture((items) => [structuredClone(room), ...items]); setPast((items) => items.slice(0, -1)); setRoom(structuredClone(previous)); setDraftCells(structuredClone(previous.cells)); setEditorError(null); }}>撤销</button>
      <button aria-label="重做" disabled={!future.length} onClick={() => { const next = future[0]; if (!next) return; setPast((items) => [...items, structuredClone(room)]); setFuture((items) => items.slice(1)); setRoom(structuredClone(next)); setDraftCells(structuredClone(next.cells)); setEditorError(null); }}>重做</button>
      <button aria-label="保存客房系列" onClick={() => void saveSeries()}>保存客房系列</button>
      <button aria-label="保存并进入楼层" onClick={() => void commands.saveRoomBlueprint(draft.name, room.cells, openings)}>保存并进入楼层</button>
    </div>
    {savedNotice && <p role="status">母版与 3 个房型变体已保存</p>}
    <VariantFilmstrip variants={variants} />
    {master && <a href="#/design/variants">同步客房系列</a>}
    {(editorError || error) && <p role="alert">{editorError ?? error}</p>}
  </main>;
}
