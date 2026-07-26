import { useState } from 'react';
import { useGame } from '../state/GameProvider';
import { prototypeConfig } from '../domain/config/prototypeConfig';
import type { Cell } from '../domain/game/state';
import { FloorPlanningPage } from './FloorPlanningPage';

export function RoomDesignPage() {
  const { state, loading, error, commands } = useGame(); const [name, setName] = useState(''); const [cells, setCells] = useState<Cell[]>([]);
  if (loading || !state) return <main><p>加载中…</p></main>;
  if (state.phase !== 'design') return <FloorPlanningPage />;
  const preset = () => { setName('云岫商务房'); setCells(Array.from({length: prototypeConfig.roomColumns * prototypeConfig.roomRows}, (_, i) => ({ x: i % prototypeConfig.roomColumns, y: Math.floor(i / prototypeConfig.roomColumns), zone: Math.floor(i / prototypeConfig.roomColumns) < 8 ? 'bedroom' : 'bathroom' }))); };
  const toggle = (x:number,y:number) => setCells(c => c.some(v=>v.x===x&&v.y===y) ? c.filter(v=>!(v.x===x&&v.y===y)) : [...c,{x,y,zone:y<8?'bedroom':'bathroom'}]);
  const metrics = state.roomBlueprint?.metrics;
  return <main className="page"><h1>设计你的第一间客房</h1><p>{prototypeConfig.roomColumns}×{prototypeConfig.roomRows} 网格，每格 {prototypeConfig.cellAreaSquareMeters}㎡</p><div className="toolbar"><button onClick={preset}>云岫商务房</button><label>房型名称<input aria-label="房型名称" value={name} onChange={e=>setName(e.target.value)} /></label></div><div className="grid" style={{gridTemplateColumns:`repeat(${prototypeConfig.roomColumns}, 1fr)`}}>{Array.from({length:prototypeConfig.roomColumns*prototypeConfig.roomRows},(_,i)=>{const x=i%prototypeConfig.roomColumns,y=Math.floor(i/prototypeConfig.roomColumns),on=cells.some(v=>v.x===x&&v.y===y); return <button key={`${x}-${y}`} aria-label={`格子 ${x},${y}`} className={on?'cell on':'cell'} onClick={()=>toggle(x,y)} />})}</div>{metrics&&<p>面积 {metrics.areaSquareMeters}㎡ · 造价 ¥{metrics.buildCostCents/100} · 建议房价 ¥{metrics.suggestedRateCents/100} · 适配度 {metrics.businessFitBps/100}%</p>}<button onClick={()=>commands.saveRoomBlueprint(name, cells)}>保存并进入楼层</button>{error&&<p role="alert">{error}</p>}<div className="preview">房间视觉预览占位</div></main>;
}
