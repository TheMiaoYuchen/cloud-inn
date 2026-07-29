import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { FACILITY_CATALOG, ITEM_CATALOG, ZONE_CATALOG } from "../domain/content/contentCatalog";
import type { PublicSpaceType } from "../domain/facilities/facilityTypes";
import { projectPublicSpacePlacement } from "../application/publicSpaceGraph";
import {
  addSpaceDoor,
  addSpaceWall,
  addSpaceWindow,
  commitSpaceEdit,
  createSpaceDraft,
  createSpaceHistory,
  eraseSpaceCell,
  paintSpaceCell,
  paintSpaceRectangle,
  placeSpaceItem,
  redoSpaceEdit,
  removePlacedItem,
  removeSpaceOpening,
  resizePlacedItem,
  rotatePlacedItem,
  undoSpaceEdit,
} from "../domain/spaces/spaceEditor";
import type { SpaceDraft, SpaceOpening, SpaceSide } from "../domain/spaces/spaceTypes";
import { validatePublicSpace } from "../domain/spaces/spaceValidation";
import { createRecommendedSpace } from "../domain/spaces/recommendedSpace";
import { useGame } from "../state/GameProvider";

const DEFAULT_SIZE = 12;
const money = (cents: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(cents / 100);

function blueprintFor(draft: SpaceDraft, id: string, name: string, cost: number) {
  return {
    id,
    type: draft.type,
    name,
    columns: draft.columns,
    rows: draft.rows,
    cells: draft.cells,
    placedItems: draft.items,
    walls: draft.walls,
    doors: draft.doors,
    windows: draft.windows,
    committedBuildCostCents: cost,
  };
}

function SelectedItemInspector({ draft, itemId, edit, remove }: {
  draft: SpaceDraft;
  itemId: string;
  edit: (operation: () => SpaceDraft) => void;
  remove: () => void;
}) {
  const item = draft.items.find(({ id }) => id === itemId);
  const [width, setWidth] = useState(item ? String(item.width) : "");
  const [height, setHeight] = useState(item ? String(item.height) : "");
  useEffect(() => {
    setWidth(item ? String(item.width) : "");
    setHeight(item ? String(item.height) : "");
  }, [item?.id, item?.width, item?.height]);
  if (!item) return null;
  const resize = (nextWidth: string, nextHeight: string) => {
    const numericWidth = Number(nextWidth);
    const numericHeight = Number(nextHeight);
    if (Number.isSafeInteger(numericWidth) && numericWidth > 0 &&
        Number.isSafeInteger(numericHeight) && numericHeight > 0) {
      edit(() => resizePlacedItem(draft, item.id, numericWidth, numericHeight));
    }
  };
  return <section className="space-selected-object" aria-label="所选物件属性"><h3>所选物件</h3>
    <label>物件目录<input aria-label="物件目录" readOnly value={item.catalogItemId} /></label>
    <label>物件类型<input aria-label="物件类型" readOnly value={ITEM_CATALOG.find(({ id }) => id === item.catalogItemId)?.name ?? item.catalogItemId} /></label>
    <label>物件位置<input aria-label="物件位置" readOnly value={`${item.x},${item.y}`} /></label>
    <label>物件宽度<input aria-label="物件宽度" type="number" min="1" value={width} onChange={(event) => { setWidth(event.target.value); resize(event.target.value, height); }} /></label>
    <label>物件高度<input aria-label="物件高度" type="number" min="1" value={height} onChange={(event) => { setHeight(event.target.value); resize(width, event.target.value); }} /></label>
    <label>物件旋转<select aria-label="物件旋转" value={item.rotation} onChange={(event) => edit(() => rotatePlacedItem(draft, item.id, Number(event.target.value) as 0 | 90 | 180 | 270))}>{([0, 90, 180, 270] as const).map((rotation) => <option key={rotation} value={rotation}>{rotation}°</option>)}</select></label>
    <button type="button" onClick={remove}>删除所选物件</button>
  </section>;
}

export function PublicSpaceDesignPage() {
  const { state, loading, commandPending, error, commands } = useGame();
  const initialType = FACILITY_CATALOG[0].type;
  const [history, setHistory] = useState(() => createSpaceHistory(createSpaceDraft(initialType, DEFAULT_SIZE, DEFAULT_SIZE)));
  const [tool, setTool] = useState<"paint" | "rectangle" | "erase" | "item" | "opening">("paint");
  const [zoneId, setZoneId] = useState<string>(FACILITY_CATALOG[0].allowedZoneIds[0]);
  const [itemId, setItemId] = useState<string>(FACILITY_CATALOG[0].permittedItemIds[0] ?? "");
  const [openingType, setOpeningType] = useState<"walls" | "doors" | "windows">("doors");
  const [openingSide, setOpeningSide] = useState<SpaceSide>("north");
  const [blueprintId, setBlueprintId] = useState(`space-blueprint:${initialType}:custom`);
  const [name, setName] = useState("云端公共空间");
  const [floorId, setFloorId] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const [notice, setNotice] = useState("");
  const [editorError, setEditorError] = useState("");
  const [rectangleAnchor, setRectangleAnchor] = useState<{ x: number; y: number }>();
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedOpening, setSelectedOpening] = useState<{
    property: "walls" | "doors" | "windows";
    opening: SpaceOpening;
  }>();
  const draft = history.present;
  const definition = FACILITY_CATALOG.find(({ type }) => type === draft.type)!;
  const validation = useMemo(() => validatePublicSpace(draft), [draft]);
  const placementOptions = useMemo(() => {
    if (!state?.phase4) return [];
    return state.phase4.floors.flatMap((floor) => {
      try {
        return [projectPublicSpacePlacement(state.phase4!, floor.id, draft.type)];
      } catch {
        return [];
      }
    });
  }, [state, draft.type]);
  const selectedPlacement = placementOptions.find(({ floor }) => floor.id === floorId);

  if (loading) return <main className="page"><p role="status">正在加载公共空间…</p></main>;
  if (!state?.phase4) return <Navigate to="/" replace />;

  const switchType = (type: PublicSpaceType) => {
    const nextDefinition = FACILITY_CATALOG.find((entry) => entry.type === type)!;
    setHistory(createSpaceHistory(createSpaceDraft(type, DEFAULT_SIZE, DEFAULT_SIZE)));
    setZoneId(nextDefinition.allowedZoneIds[0]);
    setItemId(nextDefinition.permittedItemIds[0] ?? "");
    setBlueprintId(`space-blueprint:${type}:custom`);
    setFloorId("");
    setShowIssues(false);
    setNotice("");
    setEditorError("");
    setRectangleAnchor(undefined);
    setSelectedItemId("");
    setSelectedOpening(undefined);
  };
  const edit = (next: SpaceDraft) => {
    setHistory((current) => commitSpaceEdit(current, next));
    setShowIssues(false);
    setNotice("");
    setEditorError("");
  };
  const editSafely = (operation: () => SpaceDraft) => {
    try {
      edit(operation());
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : "空间编辑未完成");
    }
  };
  const applyRecommended = () => {
    try {
      setHistory(createSpaceHistory(createRecommendedSpace(draft.type)));
      setFloorId("");
      setShowIssues(false);
      setNotice("");
      setEditorError("");
      setSelectedItemId("");
      setSelectedOpening(undefined);
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : "推荐布局未能应用");
    }
  };
  const applyCell = (x: number, y: number) => {
    try {
      if (tool === "erase") edit(eraseSpaceCell(draft, x, y));
      else if (tool === "paint") edit(paintSpaceCell(draft, { x, y, zoneId }));
      else if (tool === "rectangle") {
        if (!rectangleAnchor) {
          setRectangleAnchor({ x, y });
          return;
        }
        edit(paintSpaceRectangle(draft, {
          x: Math.min(rectangleAnchor.x, x),
          y: Math.min(rectangleAnchor.y, y),
          width: Math.abs(rectangleAnchor.x - x) + 1,
          height: Math.abs(rectangleAnchor.y - y) + 1,
        }, zoneId));
        setRectangleAnchor(undefined);
      }
      else if (tool === "item" && itemId) {
        let nextIndex = draft.items.length + 1;
        while (draft.items.some(({ id }) => id === `placed-item:${nextIndex}`)) nextIndex += 1;
        const placedId = `placed-item:${nextIndex}`;
        edit(placeSpaceItem(draft, {
        id: placedId,
        catalogItemId: itemId,
        x, y, width: 1, height: 1, rotation: 0,
        }));
        setSelectedItemId(placedId);
        setSelectedOpening(undefined);
      }
      else if (tool === "opening") {
        const opening: SpaceOpening = { x, y, side: openingSide };
        edit(openingType === "walls" ? addSpaceWall(draft, opening) : openingType === "windows" ? addSpaceWindow(draft, opening) : addSpaceDoor(draft, opening));
        setSelectedOpening({ property: openingType, opening });
        setSelectedItemId("");
      }
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : "空间编辑未完成");
      setShowIssues(true);
    }
  };
  const chooseFloor = (nextFloorId: string) => {
    setFloorId(nextFloorId);
    setSelectedItemId("");
    setSelectedOpening(undefined);
    setEditorError("");
    const placement = placementOptions.find(({ floor }) => floor.id === nextFloorId);
    const { width, height } = placement?.slot ?? {};
    if (width !== undefined && height !== undefined &&
        (width !== draft.columns || height !== draft.rows)) {
      setHistory(createSpaceHistory(createSpaceDraft(draft.type, width, height)));
      setShowIssues(false);
      setNotice("");
    }
  };
  const save = async (place: boolean) => {
    setShowIssues(true);
    setNotice("");
    if (validation.blocking.length || !name.trim()) return;
    const blueprint = blueprintFor(draft, blueprintId, name, validation.metrics.constructionCostCents);
    const saved = place
      ? Boolean(floorId) && await commands.placePublicSpace(blueprint, floorId)
      : await commands.savePublicSpaceBlueprint(blueprint);
    if (saved) setNotice(place ? "公共空间已保存并放置" : "公共空间蓝图已保存");
  };

  return <main className="page public-space-page">
    <header className="design-header"><div><p className="eyebrow">CLOUD INN · SPACE ATELIER</p><h1>公共空间设计</h1><p>以一平方米像素格规划流线、分区与高端体验。</p></div><p>每格 1㎡</p></header>
    <div className="public-space-layout">
      <aside className="space-tool-rail" aria-label="空间工具">
        <label>公共空间类型<select aria-label="公共空间类型" value={draft.type} onChange={(event) => switchType(event.target.value as PublicSpaceType)}>{FACILITY_CATALOG.map((entry) => <option key={entry.type} value={entry.type}>{entry.name}</option>)}</select></label>
        <div className="space-tool-buttons">{(["paint", "rectangle", "erase", "item", "opening"] as const).map((value) => <button type="button" aria-pressed={tool === value} key={value} onClick={() => { setTool(value); setRectangleAnchor(undefined); }}>{{ paint: "绘制分区", rectangle: "矩形绘制", erase: "擦除", item: "放置物件", opening: "设置开口" }[value]}</button>)}</div>
        <button type="button" onClick={applyRecommended}>应用推荐布局</button>
        <label>空间分区<select aria-label="空间分区" value={zoneId} onChange={(event) => setZoneId(event.target.value)}>{definition.allowedZoneIds.map((id) => <option key={id} value={id}>{ZONE_CATALOG.find((entry) => entry.id === id)?.name ?? id}</option>)}</select></label>
        <label>空间物件<select aria-label="空间物件" value={itemId} onChange={(event) => setItemId(event.target.value)}><option value="">不放置物件</option>{definition.permittedItemIds.map((id) => <option key={id} value={id}>{ITEM_CATALOG.find((entry) => entry.id === id)?.name ?? id}</option>)}</select></label>
        <label>开口类型<select aria-label="开口类型" value={openingType} onChange={(event) => setOpeningType(event.target.value as typeof openingType)}><option value="doors">门</option><option value="windows">窗</option><option value="walls">墙边</option></select></label>
        <label>开口朝向<select aria-label="开口朝向" value={openingSide} onChange={(event) => setOpeningSide(event.target.value as SpaceSide)}>{(["north", "east", "south", "west"] as const).map((side) => <option key={side} value={side}>{side}</option>)}</select></label>
      </aside>
      <section className="public-space-canvas" aria-label="公共空间画布">
        <div className="canvas-toolbar"><span>{definition.name} · {draft.columns} × {draft.rows} 格</span><span><button type="button" aria-label="撤销" disabled={!history.past.length} onClick={() => { setHistory((value) => undoSpaceEdit(value)); setSelectedItemId(""); setSelectedOpening(undefined); }}>撤销</button><button type="button" aria-label="重做" disabled={!history.future.length} onClick={() => { setHistory((value) => redoSpaceEdit(value)); setSelectedItemId(""); setSelectedOpening(undefined); }}>重做</button></span></div>
        <div className="space-grid" role="grid" aria-label="一平方米空间网格" style={{ gridTemplateColumns: `repeat(${draft.columns}, 1fr)` }}>
          {Array.from({ length: draft.columns * draft.rows }, (_, index) => {
            const x = index % draft.columns;
            const y = Math.floor(index / draft.columns);
            const cell = draft.cells.find((entry) => entry.x === x && entry.y === y);
            const item = draft.items.find((entry) => entry.x === x && entry.y === y);
            return <button type="button" role="gridcell" key={`${x}:${y}`} aria-label={`${x + 1}列${y + 1}行${cell ? `，${cell.zoneId}` : "，空白"}`} className={cell ? "space-cell filled" : "space-cell"} title={item?.catalogItemId ?? cell?.zoneId} onClick={() => applyCell(x, y)}>{item ? "◆" : ""}</button>;
          })}
        </div>
      </section>
      <aside className="space-inspector">
        <h2>空间属性</h2>
        <label>蓝图编号<input aria-label="蓝图编号" value={blueprintId} onChange={(event) => setBlueprintId(event.target.value)} /></label>
        <label>空间名称<input aria-label="空间名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <section className="space-object-list" aria-label="已放置物件"><h3>已放置物件</h3>{draft.items.length ? draft.items.map((item) => <button type="button" key={item.id} aria-pressed={selectedItemId === item.id} onClick={() => { setSelectedItemId(item.id); setSelectedOpening(undefined); }}>选择物件 {item.id}</button>) : <p>尚未放置物件</p>}</section>
        {selectedItemId && <SelectedItemInspector draft={draft} itemId={selectedItemId} edit={editSafely} remove={() => { editSafely(() => removePlacedItem(draft, selectedItemId)); setSelectedItemId(""); }} />}
        <section className="space-object-list" aria-label="空间开口列表"><h3>空间开口</h3>{(["walls", "doors", "windows"] as const).flatMap((property) => draft[property].map((opening) => <button type="button" key={`${property}:${opening.x}:${opening.y}:${opening.side}`} aria-pressed={selectedOpening?.property === property && selectedOpening.opening.x === opening.x && selectedOpening.opening.y === opening.y && selectedOpening.opening.side === opening.side} onClick={() => { setSelectedOpening({ property, opening }); setSelectedItemId(""); }}>选择开口 {property} · {opening.x},{opening.y} · {opening.side}</button>))}</section>
        {selectedOpening && <section aria-label="所选开口属性"><h3>所选开口</h3><p>{selectedOpening.property} · {selectedOpening.opening.x},{selectedOpening.opening.y} · {selectedOpening.opening.side}</p><button type="button" onClick={() => { editSafely(() => removeSpaceOpening(draft, selectedOpening.property, selectedOpening.opening)); setSelectedOpening(undefined); }}>删除所选开口</button></section>}
        <section role="region" aria-label="空间指标" className="space-metrics"><h3>空间指标</h3><p>建造成本 <strong>¥{money(validation.metrics.constructionCostCents)}</strong></p><p>接待容量 <strong>{validation.metrics.capacity} 人</strong></p><p>宾客吸引力 <strong>{validation.metrics.guestAppealBps / 100}%</strong></p><p>服务距离 <strong>{validation.metrics.serviceDistance} 格</strong></p></section>
        <section aria-label="规划问题"><h3>规划检查</h3>{showIssues && validation.blocking.length > 0 && <div role="alert"><strong>必须调整</strong><ul>{validation.blocking.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul></div>}{validation.advisory.length > 0 && <div><strong>优化建议</strong><ul>{validation.advisory.map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul></div>}</section>
        <button type="button" onClick={() => setShowIssues(true)}>验证空间</button>
        <button type="button" disabled={commandPending || validation.blocking.length > 0 || !name.trim()} onClick={() => void save(false)}>保存公共空间</button>
        <label>放置楼层<select aria-label="放置楼层" value={floorId} onChange={(event) => chooseFloor(event.target.value)}><option value="">选择设施楼层</option>{placementOptions.map(({ floor }) => <option key={floor.id} value={floor.id}>{floor.floorNumber}层 · {floor.use}</option>)}</select></label>
        <label>放置槽位<select aria-label="放置槽位" value={selectedPlacement?.slot.id ?? ""} disabled><option value="">选择楼层后自动匹配</option>{selectedPlacement && <option value={selectedPlacement.slot.id}>{selectedPlacement.slot.id}</option>}</select></label>
        {selectedPlacement && <p className="muted">锚点 {selectedPlacement.slot.anchorX ?? "旧版"},{selectedPlacement.slot.anchorY ?? "旧版"} · 容量 {selectedPlacement.slot.width ?? "沿用蓝图"}×{selectedPlacement.slot.height ?? "沿用蓝图"}㎡</p>}
        <button type="button" disabled={commandPending || validation.blocking.length > 0 || !floorId || !name.trim()} onClick={() => void save(true)}>保存并放置</button>
        {notice && <p role="status" className="success-note">{notice}</p>}
        {editorError && <p role="alert" className="command-error">{editorError}</p>}
        {error && <p role="alert" className="command-error">{error}</p>}
      </aside>
    </div>
  </main>;
}
