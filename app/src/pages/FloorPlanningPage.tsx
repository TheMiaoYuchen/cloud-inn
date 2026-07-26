import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGame } from '../state/GameProvider';
import { OperationsPage } from './OperationsPage';
import { prototypeConfig } from '../domain/config/prototypeConfig';
import { analyzeCorridorTemplate, createCorridorTemplate, type CorridorTemplateKind } from '../domain/floor/corridorTemplate';
import { FloorTemplatePicker } from '../components/floor/FloorTemplatePicker';
import { FloorOverview } from '../components/floor/FloorOverview';
import { FloorHintPanel } from '../components/floor/FloorHintPanel';

export function FloorPlanningPage() {
  const { state,error,commands,visualProvider,visualPending }=useGame();
  const [templateKind,setTemplateKind]=useState<CorridorTemplateKind>('complete-ring');
  const template=useMemo(()=>createCorridorTemplate(templateKind),[templateKind]);
  const analysis=useMemo(()=>analyzeCorridorTemplate(template),[template]);
  if(!state)return null;
  if(state.phase==='design')return <main><p>请先设计房型。</p><Link to="/design">前往设计</Link></main>;
  if(state.phase==='open')return <OperationsPage/>;
  const bp=state.roomBlueprint,labels=['西北','东北','西南','东南'];
  return <main className="page floor-page"><span className="legacy-title">固定楼层槽位</span><header className="design-header"><div><p className="eyebrow">云岫酒店 · 28 层</p><h1>高层酒店楼层规划</h1><p>选择近方形核心筒与环廊模板，再用不同尺寸的客房系列替换槽位。</p></div><button onClick={()=>commands.requestVisual(visualProvider)} disabled={visualPending}>{visualPending?'生成中…':'生成效果图'}</button></header>{bp?.visual.status==='error'&&<p role="alert">效果图生成失败：{bp.visual.message}，不影响继续规划楼层。</p>}<div className="floor-editor-layout"><FloorTemplatePicker selected={templateKind} onSelect={setTemplateKind}/><FloorOverview template={template} variants={state.phase2?.roomVariants ?? []}/><FloorHintPanel analysis={analysis}/></div><p>现金 ¥{state.cashCents/100} · 已建 {state.floor.rooms.length}/4 · 总建造成本 ¥{state.floor.rooms.reduce((s,r)=>s+r.committedBuildCostCents,0)/100}</p><div className="slots legacy-slots">{prototypeConfig.floorSlots.map((slot,i)=>{const room=state.floor.rooms.find(r=>r.slotId===slot.id);return <button key={slot.id} onClick={()=>!room&&commands.placeRoom(slot.id)} disabled={!!room}>{room?`${bp?.name} · ${bp?.metrics.areaSquareMeters}㎡ · ¥${room.committedBuildCostCents/100}`:`${labels[i]}槽位 · 空置`}</button>})}</div><button onClick={()=>commands.openHotel()} disabled={state.floor.rooms.length===0}>进入运营</button>{error&&<p role="alert">{error}</p>}</main>;
}
