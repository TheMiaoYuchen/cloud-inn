import { useMemo, useState } from 'react';
import { previewMasterSync, selectAllSyncChanges, selectNoneSyncChanges } from '../domain/design/roomSeries';
import { useGame } from '../state/GameProvider';

export function RoomVariantPage() {
  const {state,commands,error}=useGame(); const phase2=state?.phase2,master=phase2?.roomMaster;
  const [lighting,setLighting]=useState(master?.gene.lighting??''); const [selected,setSelected]=useState<Set<string>>(new Set());
  const changedMaster=useMemo(()=>master?{...master,gene:{...master.gene,lighting}}:null,[master,lighting]);
  const preview=useMemo(()=>master&&changedMaster&&phase2?previewMasterSync(master,changedMaster,phase2.roomVariants):[],[master,changedMaster,phase2]);
  if(!master||!phase2||!changedMaster)return <main className="page"><h1>客房系列同步</h1><p>请先创建客房母版。</p></main>;
  const choices=preview.map(change=>({...change,selected:selected.has(change.id)}));
  return <main className="page"><h1>客房系列同步</h1><p>母版变化按房型、按属性逐项确认；未选择的独立设计会保留。</p><label>母版灯光<input aria-label="母版灯光" value={lighting} onChange={event=>setLighting(event.target.value)}/></label><div><button onClick={()=>setSelected(new Set(selectAllSyncChanges(preview).map(item=>item.id)))}>全选</button><button onClick={()=>{selectNoneSyncChanges(preview);setSelected(new Set())}}>全不选</button></div><ul>{choices.map(change=><li key={change.id}><label><input type="checkbox" checked={change.selected} onChange={()=>setSelected(items=>{const next=new Set(items);next.has(change.id)?next.delete(change.id):next.add(change.id);return next;})}/>{phase2.roomVariants.find(item=>item.id===change.variantId)?.name} · {change.property==='gene'?'整体风格':'面积与户型'}</label></li>)}</ul><button disabled={!choices.some(item=>item.selected)} onClick={()=>void commands.syncRoomSeries(changedMaster,choices)}>应用所选同步</button>{!preview.length&&<p>修改母版属性后可预览同步项。</p>}{error&&<p role="alert">{error}</p>}</main>;
}
