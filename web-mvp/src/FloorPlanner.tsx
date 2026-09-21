import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { bedTypes, roomTypes, zoneChoices } from "./catalog";
import { listFloorPlans, saveFloorPlan } from "./storage";
import type { Blueprint, FloorPlacement, FloorPlan, FloorPoint } from "./types";

const FLOOR_AREA = 1200;
const FIRST_FLOOR = 56;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const CELL_AREA = FLOOR_AREA / (GRID_COLUMNS * GRID_ROWS);
const roleLabels = { arrival: "抵达", stay: "停留", restore: "恢复", gather: "聚集" } as const;
type DrawingTool = "rectangle" | "freehand";
type DraftTarget = { kind: "blueprint"; blueprint: Blueprint } | { kind: "corridor" } | { kind: "staff" };
type LegacyPlacement = Partial<FloorPlacement> & { shape?: FloorPoint[]; x?: number; y?: number; width?: number; height?: number };

function createEmptyFloor(floorNumber: number): FloorPlan {
  return { id: `floor-${crypto.randomUUID()}`, floorNumber, name: `${floorNumber}F`, placements: [], updatedAt: new Date().toISOString() };
}

function nameFor(blueprint: Blueprint) {
  if (blueprint.designKind === "zone") return blueprint.name || zoneChoices.find((item) => item.id === blueprint.zoneTypeId)?.name || "功能区域";
  return blueprint.name || roomTypes.find((item) => item.id === blueprint.roomTypeId)?.name || "客房";
}
function targetName(target: DraftTarget) { return target.kind === "blueprint" ? nameFor(target.blueprint) : target.kind === "corridor" ? "走廊" : "职员区域"; }
function targetKey(target: DraftTarget) { return target.kind === "blueprint" ? `blueprint:${target.blueprint.id}` : target.kind; }
function isRoomTarget(target: DraftTarget) { return target.kind === "blueprint" && target.blueprint.designKind === "room"; }
function placementName(placement: FloorPlacement, blueprints: Blueprint[]) {
  if (placement.kind === "corridor") return "走廊";
  if (placement.kind === "staff") return "职员区域";
  const blueprint = blueprints.find((item) => item.id === placement.blueprintId);
  return blueprint ? nameFor(blueprint) : "未找到的蓝图";
}
function placementVisualKind(placement: FloorPlacement, blueprints: Blueprint[]) {
  if (placement.kind !== "blueprint") return placement.kind;
  const blueprint = blueprints.find((item) => item.id === placement.blueprintId);
  if (!blueprint) return "blueprint";
  return blueprint.designKind === "room" ? "room" : `zone-${blueprint.zoneTypeId ?? "default"}`;
}
function isRoomPlacement(placement: FloorPlacement, blueprints: Blueprint[]) { return placement.kind === "blueprint" && blueprints.find((item) => item.id === placement.blueprintId)?.designKind === "room"; }

function clampPoint(point: FloorPoint): FloorPoint { return { x: Math.max(0, Math.min(GRID_COLUMNS, point.x)), y: Math.max(0, Math.min(GRID_ROWS, point.y)) }; }
function polygonArea(points: FloorPoint[]) { return Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2; }
function pointInPolygon(point: FloorPoint, polygon: FloorPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]; const before = polygon[previous];
    const crosses = (current.y > point.y) !== (before.y > point.y) && point.x < (before.x - current.x) * (point.y - current.y) / (before.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function coveredCells(shape: FloorPoint[]) {
  const cells = new Set<string>();
  for (let x = 0; x < GRID_COLUMNS; x += 1) for (let y = 0; y < GRID_ROWS; y += 1) if (pointInPolygon({ x: x + .5, y: y + .5 }, shape)) cells.add(`${x}:${y}`);
  return cells;
}
function cellsForShapes(shapes: FloorPoint[][]) { const cells = new Set<string>(); shapes.forEach((shape) => coveredCells(shape).forEach((cell) => cells.add(cell))); return cells; }
function areaForShapes(shapes: FloorPoint[][]) { return cellsForShapes(shapes).size * CELL_AREA; }
function cellCoordinates(cell: string) { return cell.split(":").map(Number) as [number, number]; }
function unionFillPath(shapes: FloorPoint[][]) {
  return [...cellsForShapes(shapes)].map((cell) => { const [x, y] = cellCoordinates(cell); return `M${x} ${y}h1v1h-1Z`; }).join(" ");
}
function unionOutlinePath(shapes: FloorPoint[][]) {
  const cells = cellsForShapes(shapes);
  return [...cells].flatMap((cell) => {
    const [x, y] = cellCoordinates(cell);
    return [
      !cells.has(`${x}:${y - 1}`) && `M${x} ${y}H${x + 1}`,
      !cells.has(`${x + 1}:${y}`) && `M${x + 1} ${y}V${y + 1}`,
      !cells.has(`${x}:${y + 1}`) && `M${x + 1} ${y + 1}H${x}`,
      !cells.has(`${x - 1}:${y}`) && `M${x} ${y + 1}V${y}`,
    ].filter(Boolean) as string[];
  }).join(" ");
}
function overlaps(shape: FloorPoint[], placements: FloorPlacement[]) {
  const cells = coveredCells(shape);
  return placements.some((placement) => [...cellsForShapes(placement.shapes)].some((cell) => cells.has(cell)));
}
function sharesSide(aShapes: FloorPoint[][], bShapes: FloorPoint[][]) {
  const bCells = cellsForShapes(bShapes);
  return [...cellsForShapes(aShapes)].some((cell) => {
    const [x, y] = cell.split(":").map(Number);
    return [`${x - 1}:${y}`, `${x + 1}:${y}`, `${x}:${y - 1}`, `${x}:${y + 1}`].some((neighbour) => bCells.has(neighbour));
  });
}
function hasCorridorAccess(shapes: FloorPoint[][], placements: FloorPlacement[]) { return placements.filter((placement) => placement.kind === "corridor").some((corridor) => sharesSide(shapes, corridor.shapes)); }
function simplify(points: FloorPoint[]) { return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y); }
function rectangleFrom(start: FloorPoint, end: FloorPoint): FloorPoint[] {
  const left = Math.min(start.x, end.x); const right = Math.max(start.x, end.x); const top = Math.min(start.y, end.y); const bottom = Math.max(start.y, end.y);
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}
function pointsAttribute(points: FloorPoint[]) { return points.map((point) => `${point.x},${point.y}`).join(" "); }
function labelPoint(shapes: FloorPoint[][]) { const points = shapes.flat(); return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }; }
function normaliseFloorPlan(plan: FloorPlan): FloorPlan {
  const storedFloorNumber = Number.isInteger(plan.floorNumber) && plan.floorNumber > 0 ? plan.floorNumber : 1;
  const floorNumber = storedFloorNumber < FIRST_FLOOR ? FIRST_FLOOR + storedFloorNumber - 1 : storedFloorNumber;
  const defaultName = !plan.name || /^第\s*\d+\s*层$/.test(plan.name);
  return {
    ...plan,
    floorNumber,
    name: defaultName ? `${floorNumber}F` : plan.name,
    placements: (plan.placements as LegacyPlacement[]).flatMap((placement) => {
      const shapes = Array.isArray(placement.shapes) && placement.shapes.length
        ? placement.shapes.filter((shape) => Array.isArray(shape) && shape.length >= 3).map((shape) => shape.map(clampPoint))
        : Array.isArray(placement.shape) && placement.shape.length >= 3
          ? [placement.shape.map(clampPoint)]
          : (() => { const x = placement.x ?? 0; const y = placement.y ?? 0; const width = placement.width ?? 1; const height = placement.height ?? 1; return [rectangleFrom({ x, y }, { x: x + width, y: y + height }).map(clampPoint)]; })();
      if (!placement.id || !shapes.some((shape) => polygonArea(shape) > 0)) return [];
      return [{ id: placement.id, kind: placement.kind ?? "blueprint", blueprintId: placement.blueprintId, shapes, areaSqm: placement.areaSqm ?? areaForShapes(shapes), allocatedAreaSqm: placement.allocatedAreaSqm ?? areaForShapes(shapes), journeyRole: placement.journeyRole ?? "stay" }];
    }),
  };
}
function pointFromEvent(event: PointerEvent<HTMLDivElement>, board: HTMLDivElement) {
  const bounds = board.getBoundingClientRect();
  return clampPoint({ x: Math.round(((event.clientX - bounds.left) / bounds.width) * GRID_COLUMNS), y: Math.round(((event.clientY - bounds.top) / bounds.height) * GRID_ROWS) });
}

type FloorPlannerProps = { blueprints: Blueprint[]; onOpenBlueprint: (blueprint: Blueprint) => void };

export function FloorPlanner({ blueprints, onOpenBlueprint }: FloorPlannerProps) {
  const [floorPlans, setFloorPlans] = useState<FloorPlan[]>(() => [createEmptyFloor(FIRST_FLOOR)]);
  const [activeFloorId, setActiveFloorId] = useState(() => floorPlans[0].id);
  const [ready, setReady] = useState(false);
  const [armedTarget, setArmedTarget] = useState<DraftTarget>();
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("rectangle");
  const [draftShapes, setDraftShapes] = useState<FloorPoint[][]>([]);
  const [drawing, setDrawing] = useState<FloorPoint[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [formatConfirmationOpen, setFormatConfirmationOpen] = useState(false);
  const [notice, setNotice] = useState("先建设走廊，再将客房接入走廊；功能区和职员区域可自由布局。每格约 2㎡。");
  const boardRef = useRef<HTMLDivElement>(null);

  const floorPlan = floorPlans.find((plan) => plan.id === activeFloorId) ?? floorPlans[0];

  useEffect(() => { void listFloorPlans().then((stored) => { const plans = stored.length ? stored.map(normaliseFloorPlan).sort((left, right) => left.floorNumber - right.floorNumber) : [createEmptyFloor(FIRST_FLOOR)]; setFloorPlans(plans); setActiveFloorId(plans[0].id); setReady(true); }).catch(() => { setNotice("楼层平面暂时无法保存。"); setReady(true); }); }, []);
  useEffect(() => { if (!ready || !floorPlan) return; const timer = window.setTimeout(() => { void saveFloorPlan(floorPlan).catch(() => setNotice("保存楼层平面失败。")); }, 350); return () => window.clearTimeout(timer); }, [floorPlan, ready]);

  const usedArea = useMemo(() => floorPlan.placements.reduce((sum, placement) => sum + placement.allocatedAreaSqm, 0), [floorPlan.placements]);
  const selected = floorPlan.placements.find((placement) => placement.id === selectedId);
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selected?.blueprintId);
  const activeShape = drawing && (drawingTool === "rectangle" ? rectangleFrom(drawing[0], drawing[drawing.length - 1]) : simplify(drawing));
  const draftArea = areaForShapes(draftShapes);
  const previewArea = activeShape && activeShape.length >= 3 ? areaForShapes([...draftShapes, activeShape]) : draftArea;
  const previewOverlap = Boolean(activeShape && activeShape.length >= 3 && overlaps(activeShape, floorPlan.placements));
  const requiredArea = armedTarget?.kind === "blueprint" ? armedTarget.blueprint.areaSqm : CELL_AREA;
  const corridorConnected = Boolean(armedTarget && (!isRoomTarget(armedTarget) || hasCorridorAccess(draftShapes, floorPlan.placements)));
  const canDeploy = Boolean(armedTarget && draftShapes.length && draftArea >= requiredArea && usedArea + draftArea <= FLOOR_AREA && !draftShapes.some((shape) => overlaps(shape, floorPlan.placements)) && corridorConnected);
  const disconnectedRooms = floorPlan.placements.filter((placement) => isRoomPlacement(placement, blueprints) && !hasCorridorAccess(placement.shapes, floorPlan.placements));
  const showEntrance = floorPlan.floorNumber === Math.min(...floorPlans.map((plan) => plan.floorNumber));
  const limitedBlueprintIdsInUse = new Set(floorPlans.flatMap((plan) => plan.placements.flatMap((placement) => placement.kind === "blueprint" && placement.blueprintId ? [placement.blueprintId] : [])));

  function updateFloorPlan(update: (current: FloorPlan) => FloorPlan) { setFloorPlans((current) => current.map((plan) => plan.id === floorPlan.id ? update(plan) : plan)); }
  function updatePlacements(update: (placements: FloorPlacement[]) => FloorPlacement[]) { updateFloorPlan((current) => ({ ...current, placements: update(current.placements), updatedAt: new Date().toISOString() })); }
  function resetTransientState() { setArmedTarget(undefined); setDraftShapes([]); setDrawing(undefined); setSelectedId(undefined); }
  function switchFloor(id: string) { setActiveFloorId(id); resetTransientState(); setNotice(`已切换到 ${floorPlans.find((plan) => plan.id === id)?.name ?? "所选楼层"}。`); }
  function addEmptyFloor() {
    const next = createEmptyFloor(Math.max(...floorPlans.map((plan) => plan.floorNumber)) + 1);
    setFloorPlans((current) => [...current, next]); setActiveFloorId(next.id); resetTransientState(); setNotice(`已新建 ${next.name}，可从走廊开始规划。`);
  }
  function copyCurrentFloor() {
    const floorNumber = Math.max(...floorPlans.map((plan) => plan.floorNumber)) + 1;
    const next: FloorPlan = { ...floorPlan, id: `floor-${crypto.randomUUID()}`, floorNumber, name: `${floorNumber}F`, placements: floorPlan.placements.map((placement) => ({ ...placement, id: crypto.randomUUID(), shapes: placement.shapes.map((shape) => shape.map((point) => ({ ...point }))) })), updatedAt: new Date().toISOString() };
    setFloorPlans((current) => [...current, next]); setActiveFloorId(next.id); resetTransientState(); setNotice(`已复制 ${floorPlan.name} 为 ${next.name}。`);
  }
  function requestFormatFloor() {
    resetTransientState(); setFormatConfirmationOpen(true);
  }
  function confirmFormatFloor() {
    updateFloorPlan((current) => ({ ...current, placements: [], updatedAt: new Date().toISOString() }));
    resetTransientState(); setNotice(`已格式化 ${floorPlan.name}，现在是一张空白平面图。`); setFormatConfirmationOpen(false);
  }
  function arm(target: DraftTarget) {
    if (target.kind === "blueprint" && target.blueprint.isLimited && limitedBlueprintIdsInUse.has(target.blueprint.id)) { setNotice(`限定蓝图「${nameFor(target.blueprint)}」已在酒店中部署，只能建造一处。`); return; }
    setArmedTarget(target); setSelectedId(undefined); setDraftShapes([]); setDrawing(undefined);
    setNotice(target.kind === "corridor" ? "正在建设走廊：画出一段或多段相连的通道。" : target.kind === "staff" ? "正在预留职员区域：后续可用于员工、布草间及后勤需求。" : isRoomTarget(target) ? `已选择「${targetName(target)}」：需要至少 ${target.blueprint.areaSqm}㎡，并且必须与走廊共边相连。` : `已选择「${targetName(target)}」：需要至少 ${target.blueprint.areaSqm}㎡。`);
  }
  function cancelDraft() { setArmedTarget(undefined); setDraftShapes([]); setDrawing(undefined); setNotice("已取消本次圈地。"); }
  function undoDraftShape() { setDraftShapes((current) => current.slice(0, -1)); setNotice("已撤回最后一块区域，可重新绘制。"); }
  function startDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!armedTarget || !boardRef.current || event.button !== 0 || (event.target as Element).closest(".floor-shape")) return;
    event.currentTarget.setPointerCapture(event.pointerId); setDrawing([pointFromEvent(event, boardRef.current)]);
  }
  function continueDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !boardRef.current) return;
    const point = pointFromEvent(event, boardRef.current);
    setDrawing((current) => current ? drawingTool === "rectangle" ? [current[0], point] : simplify([...current, point]) : current);
  }
  function finishDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || !armedTarget || !boardRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const raw = drawingTool === "rectangle" ? rectangleFrom(drawing[0], pointFromEvent(event, boardRef.current)) : simplify([...drawing, pointFromEvent(event, boardRef.current)]);
    if (raw.length < 3 || polygonArea(raw) === 0 || areaForShapes([raw]) === 0) { setNotice("请画出至少覆盖一个网格的区域。"); setDrawing(undefined); return; }
    if (overlaps(raw, floorPlan.placements)) { setNotice("这块区域与已部署空间重叠，请换一块空白区域。"); setDrawing(undefined); return; }
    const nextShapes = [...draftShapes, raw]; const nextArea = areaForShapes(nextShapes);
    if (usedArea + nextArea > FLOOR_AREA) { setNotice("加入这块区域会超过 1200㎡ 楼层上限。"); setDrawing(undefined); return; }
    setDraftShapes(nextShapes); setDrawing(undefined);
    const base = nextArea >= requiredArea ? `已圈定 ${nextArea}㎡，可继续叠加或确认部署。` : `已圈定 ${nextArea}㎡，距离 ${requiredArea}㎡ 还差 ${requiredArea - nextArea}㎡。继续画一个区域叠加即可。`;
    setNotice(isRoomTarget(armedTarget) && !hasCorridorAccess(nextShapes, floorPlan.placements) ? `${base} 客房还需要与至少一段走廊共边相连。` : base);
  }
  function deployDraft() {
    if (!armedTarget || !canDeploy) return;
    const placement: FloorPlacement = { id: crypto.randomUUID(), kind: armedTarget.kind, blueprintId: armedTarget.kind === "blueprint" ? armedTarget.blueprint.id : undefined, shapes: draftShapes, areaSqm: requiredArea, allocatedAreaSqm: draftArea, journeyRole: armedTarget.kind === "corridor" ? "arrival" : armedTarget.kind === "staff" ? "restore" : armedTarget.blueprint.designKind === "zone" ? "gather" : "stay" };
    updatePlacements((items) => [...items, placement]); setSelectedId(placement.id); setArmedTarget(undefined); setDraftShapes([]); setNotice(`已部署「${targetName(armedTarget)}」，占用 ${draftArea}㎡。`);
  }
  function removeSelected() {
    if (!selected) return;
    const remaining = floorPlan.placements.filter((item) => item.id !== selected.id);
    const breaksRoomAccess = selected.kind === "corridor" && floorPlan.placements.some((room) => isRoomPlacement(room, blueprints) && hasCorridorAccess(room.shapes, floorPlan.placements) && !hasCorridorAccess(room.shapes, remaining));
    if (breaksRoomAccess) { setNotice("这段走廊仍是客房的唯一入口，先为客房接入另一段走廊后才能移除。"); return; }
    updatePlacements(() => remaining); setSelectedId(undefined); setNotice(`已移出「${placementName(selected, blueprints)}」。`);
  }

  return <section className="floor-workspace" aria-label="楼层平面图">
    <div className="floor-heading"><div><p className="eyebrow">高空酒店 · 56F 起</p><h2>{floorPlan.name} 平面图</h2><p>每层均为 1200㎡。先铺设走廊，再让每间客房与走廊相连；餐饮、功能区及职员区域可按经营需求自由连通和布局。</p></div><div className="floor-meter"><strong>{usedArea}</strong><span>/ {FLOOR_AREA} m² 已规划</span><i><b style={{ width: `${Math.min(100, usedArea / FLOOR_AREA * 100)}%` }} /></i></div></div>
    <nav className="floor-levels" aria-label="酒店楼层"><div><span>酒店楼层</span>{floorPlans.map((plan) => <button key={plan.id} type="button" className={plan.id === floorPlan.id ? "selected" : ""} onClick={() => switchFloor(plan.id)}>{plan.floorNumber}F</button>)}</div><div><button type="button" onClick={addEmptyFloor}>＋ 新建空白层</button><button type="button" onClick={copyCurrentFloor}>复制当前层</button><button type="button" className="floor-action danger" onClick={requestFormatFloor}>格式化当前层</button></div></nav>
    <div className="floor-layout">
      <aside className="floor-library"><div className="floor-library-heading"><strong>可部署空间</strong><span>{blueprints.length} 张蓝图</span></div><p className="floor-library-section">基础设施</p><button type="button" className={`floor-infrastructure corridor ${armedTarget && targetKey(armedTarget) === "corridor" ? "armed" : ""}`} onClick={() => arm({ kind: "corridor" })}><span>↔</span><div><strong>走廊</strong><small>客房需要与走廊共边相连</small></div><b>建设</b></button><button type="button" className={`floor-infrastructure staff ${armedTarget && targetKey(armedTarget) === "staff" ? "armed" : ""}`} onClick={() => arm({ kind: "staff" })}><span>◫</span><div><strong>职员区域</strong><small>预留员工、布草与后勤需求</small></div><b>预留</b></button><p className="floor-library-section">已设计空间</p>{blueprints.length ? blueprints.map((blueprint) => { const unavailable = blueprint.isLimited && limitedBlueprintIdsInUse.has(blueprint.id); return <button type="button" disabled={unavailable} className={`floor-source ${armedTarget?.kind === "blueprint" && armedTarget.blueprint.id === blueprint.id ? "armed" : ""}`} key={blueprint.id} onClick={() => arm({ kind: "blueprint", blueprint })} onDoubleClick={() => onOpenBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt="" /><div><strong>{nameFor(blueprint)}{blueprint.isLimited && " · 限定"}</strong><span>{blueprint.areaSqm} m² · {unavailable ? "已部署" : blueprint.designKind === "zone" ? "功能区域" : bedTypes.find((item) => item.id === blueprint.bedTypeId)?.name}</span></div><b>{unavailable ? "唯一" : armedTarget?.kind === "blueprint" && armedTarget.blueprint.id === blueprint.id ? "圈地中" : "选择"}</b></button>; }) : <p className="floor-empty">蓝图库还没有可部署的客房或功能区域。</p>}</aside>
      <div className="floor-board-wrap"><div className="floor-tools" aria-label="圈地工具"><span>圈地工具</span><button type="button" className={drawingTool === "rectangle" ? "selected" : ""} onClick={() => setDrawingTool("rectangle")}>矩形</button><button type="button" className={drawingTool === "freehand" ? "selected" : ""} onClick={() => setDrawingTool("freehand")}>自由轮廓</button>{armedTarget && <><em>{draftShapes.length ? `${draftShapes.length} 块 · ${draftArea}㎡` : "尚未圈地"}</em><button type="button" className="floor-cancel" disabled={!draftShapes.length} onClick={undoDraftShape}>撤回一块</button><button type="button" className="floor-cancel" onClick={cancelDraft}>取消</button><button type="button" className="floor-deploy" disabled={!canDeploy} onClick={deployDraft}>确认部署</button></>}</div><div ref={boardRef} className={`floor-board ${armedTarget ? "drawing-enabled" : ""}`} onPointerDown={startDrawing} onPointerMove={continueDrawing} onPointerUp={finishDrawing} onPointerCancel={() => setDrawing(undefined)} onClick={() => !drawing && setSelectedId(undefined)}>{showEntrance && <span className="floor-entrance">入口</span>}<svg className="floor-shapes" viewBox={`0 0 ${GRID_COLUMNS} ${GRID_ROWS}`} preserveAspectRatio="none" aria-label="已部署空间">{floorPlan.placements.map((placement) => { const label = labelPoint(placement.shapes); const hasAccess = !isRoomPlacement(placement, blueprints) || hasCorridorAccess(placement.shapes, floorPlan.placements); return <g key={placement.id} className={`floor-shape ${placementVisualKind(placement, blueprints)} ${selectedId === placement.id ? "selected" : ""} ${hasAccess ? "" : "needs-corridor"}`} onPointerDown={(event) => { event.stopPropagation(); setSelectedId(placement.id); }} onClick={(event) => event.stopPropagation()}><path className="floor-shape-fill" d={unionFillPath(placement.shapes)} /><path className="floor-shape-outline" d={unionOutlinePath(placement.shapes)} /><text x={label.x} y={label.y - .35}>{placementName(placement, blueprints)}</text><text className="floor-shape-meta" x={label.x} y={label.y + .45}>{placement.allocatedAreaSqm}m² · {hasAccess ? roleLabels[placement.journeyRole] : "待接入走廊"}</text></g>; })}{draftShapes.map((shape, index) => <polygon className="floor-draft" key={`draft-${index}`} points={pointsAttribute(shape)} />)}{activeShape && activeShape.length >= 3 && <polygon className={`floor-drawing ${previewOverlap || previewArea > FLOOR_AREA - usedArea ? "invalid" : ""}`} points={pointsAttribute(activeShape)} />}</svg></div><p className="floor-notice" role="status">{drawing && armedTarget ? `正在圈地：组合后 ${previewArea}㎡ / 至少 ${requiredArea}㎡` : disconnectedRooms.length ? `${notice} 另有 ${disconnectedRooms.length} 间已部署客房等待接入走廊。` : notice}</p></div>
      <aside className="floor-inspector">{selected ? selected.kind === "blueprint" && selectedBlueprint ? <><p className="eyebrow">空间设定</p><h3>{nameFor(selectedBlueprint)}</h3><span>蓝图需求 {selected.areaSqm} m² · 当前占地 {selected.allocatedAreaSqm} m²</span>{selectedBlueprint.designKind === "room" && !hasCorridorAccess(selected.shapes, floorPlan.placements) && <p className="inspector-warning">该客房尚未接入走廊。请在其边界外新增一段走廊。</p>}<label>在旅程中的角色<select value={selected.journeyRole} onChange={(event) => updatePlacements((items) => items.map((item) => item.id === selected.id ? { ...item, journeyRole: event.target.value as FloorPlacement["journeyRole"] } : item))}>{Object.entries(roleLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p className="inspector-hint">这个标签将用于后续模拟客流、噪音和满意度。</p><div><button type="button" className="remove-space" onClick={removeSelected}>移出楼层</button></div></> : <><p className="eyebrow">基础设施</p><h3>{placementName(selected, blueprints)}</h3><span>占地 {selected.allocatedAreaSqm} m²</span><p className="inspector-hint">{selected.kind === "corridor" ? "走廊是客房的必要入口；移除时会保护仍依赖它的客房。" : "职员区域将保留给后续的员工调度、布草间和后勤服务系统。"}</p><div><button type="button" className="remove-space" onClick={removeSelected}>移出楼层</button></div></> : <div className="inspector-empty"><span>◇</span><h3>{armedTarget ? "叠加圈地中" : "从走廊开始"}</h3><p>{armedTarget ? `${isRoomTarget(armedTarget) ? "客房需与走廊共边相连；" : ""}为「${targetName(armedTarget)}」圈出至少 ${requiredArea}㎡，达到要求后点击“确认部署”。` : "先建设走廊，再部署客房；职员区域可为后续经营系统预留。"}</p></div>}</aside>
    </div>
    {formatConfirmationOpen && <div className="floor-action-backdrop" role="presentation"><section className="floor-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby="floor-action-title"><p className="eyebrow">请再次确认</p><h3 id="floor-action-title">格式化 {floorPlan.name}？</h3><p>这会移除当前楼层的全部空间、走廊和职员区域，且无法撤销。</p><div><button type="button" onClick={() => setFormatConfirmationOpen(false)}>取消</button><button type="button" className="danger" onClick={confirmFormatFloor}>确认格式化</button></div></section></div>}
  </section>;
}
