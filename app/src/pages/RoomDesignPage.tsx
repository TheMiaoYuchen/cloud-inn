import { useState } from 'react';
import { prototypeConfig } from '../domain/config/prototypeConfig';
import { evaluateRoom } from '../domain/room/evaluateRoom';
import { STYLE_PRESETS, CONTEMPORARY_ORIENTAL } from '../domain/design/stylePresets';
import { useGame } from '../state/GameProvider';
import { FloorPlanningPage } from './FloorPlanningPage';
import { RoomToolRail, type EditorTool } from '../components/design/RoomToolRail';
import { RoomPropertyPanel } from '../components/design/RoomPropertyPanel';
import { VariantFilmstrip } from '../components/design/VariantFilmstrip';

export function RoomDesignPage() {
  const { state, loading, error, commands, draft, setDraftName, setDraftCells, setActiveZone, setTool, applyDraftCell, applyDraftRectangle } = useGame();
  const [rectangleStart, setRectangleStart] = useState<{ x: number; y: number } | null>(null);
  const [selectedPreset, setSelectedPreset] = useState(CONTEMPORARY_ORIENTAL.id);
  const [savedNotice, setSavedNotice] = useState(false);
  const [editorTool,setEditorTool]=useState<EditorTool>('paint');
  const [history,setHistory]=useState<typeof draft.cells[]>([]);
  const [future,setFuture]=useState<typeof draft.cells[]>([]);
  const [openings,setOpenings]=useState<Array<{x:number;y:number;side:'north';kind:'wall'|'door'|'window'}>>([]);
  if (loading) return <main><p>加载中…</p></main>;
  if (!state) return <main>{error && <p role="alert">{error}</p>}</main>;
  if (state.phase !== 'design') return <FloorPlanningPage />;
  const metrics = (() => { try { return evaluateRoom(draft.cells, prototypeConfig.roomColumns, prototypeConfig.roomRows); } catch { return null; } })();
  const preset = () => {
    setDraftName('云岫商务房');
    setDraftCells(Array.from({ length: 96 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), zone: Math.floor(i / 8) < 8 ? 'bedroom' : 'bathroom' })));
  };
  const editCell = (x: number, y: number) => {
    if (editorTool === 'select') return;
    if (editorTool === 'wall' || editorTool === 'door' || editorTool === 'window') { setOpenings(items=>[...items.filter(item=>item.x!==x||item.y!==y),{x,y,side:'north',kind:editorTool}]); return; }
    setHistory(items=>[...items,structuredClone(draft.cells)]); setFuture([]);
    if (draft.tool !== 'rectangle') return applyDraftCell(x, y);
    if (!rectangleStart) return setRectangleStart({ x, y });
    applyDraftRectangle(rectangleStart.x, rectangleStart.y, x, y); setRectangleStart(null);
  };
  const saveSeries = async () => {
    const saved = await commands.saveRoomSeries({ id: 'room-master-1', name: draft.name, cells: draft.cells, openings:{walls:openings.filter(item=>item.kind==='wall'),doors:openings.filter(item=>item.kind==='door'),windows:openings.filter(item=>item.kind==='window')}, gene: STYLE_PRESETS.find(p => p.id === selectedPreset)?.gene ?? CONTEMPORARY_ORIENTAL.gene });
    setSavedNotice(saved);
  };
  const variants = state.phase2?.roomVariants ?? [];
  return <main className="page design-page">
    <header className="design-header"><div><p className="eyebrow">云岫酒店 · 设计工作台</p><h1>设计你的第一间客房</h1></div><button aria-label="云岫商务房" onClick={preset}>载入24㎡示例户型</button></header>
    <div className="editor-layout">
      <RoomToolRail activeZone={draft.activeZone} tool={editorTool} onZone={setActiveZone} onTool={tool => { setEditorTool(tool); if (tool==='paint'||tool==='erase'||tool==='rectangle') setTool(tool); setRectangleStart(null); }} />
      <section className="canvas-panel" aria-label="房型画布" role="region"><div className="canvas-toolbar"><span>1 格 = 0.25㎡</span><span>{rectangleStart ? '请选择第二个角点' : '点击格子开始绘制'}</span></div><div className="grid design-grid" style={{ gridTemplateColumns: 'repeat(8,1fr)' }}>{Array.from({ length: 96 }, (_, i) => { const x = i % 8, y = Math.floor(i / 8), cell = draft.cells.find(c => c.x === x && c.y === y); return <button key={`${x}-${y}`} aria-label={`格子 ${x},${y}`} aria-pressed={Boolean(cell)} data-zone={cell?.zone} data-opening={openings.find(item=>item.x===x&&item.y===y)?.kind} className={cell ? `cell on ${cell.zone}` : 'cell'} onClick={() => editCell(x, y)} />; })}</div><p className="canvas-note">拖拽或点击格子划分功能区；房间大小、材质与风格会共同影响造价和后续房价。</p></section>
      <RoomPropertyPanel name={draft.name} metrics={metrics} presets={STYLE_PRESETS} selectedPreset={selectedPreset} onName={setDraftName} onPreset={preset => setSelectedPreset(preset.id)} />
    </div>
    <div className="editor-actions"><button aria-label="撤销" disabled={!history.length} onClick={()=>{const previous=history[history.length-1];if(previous){setFuture(items=>[structuredClone(draft.cells),...items]);setDraftCells(previous);setHistory(items=>items.slice(0,-1));}}}>撤销</button><button aria-label="重做" disabled={!future.length} onClick={()=>{const next=future[0];if(next){setHistory(items=>[...items,structuredClone(draft.cells)]);setDraftCells(next);setFuture(items=>items.slice(1));}}}>重做</button><button aria-label="保存客房系列" onClick={() => void saveSeries()}>保存客房系列</button><button aria-label="保存并进入楼层" onClick={() => void commands.saveRoomBlueprint(draft.name, draft.cells)}>保存并进入楼层</button></div>
    {savedNotice && <p role="status">母版与 3 个房型变体已保存</p>}
    <VariantFilmstrip variants={variants} />
    {error && <p role="alert">{error}</p>}
  </main>;
}
