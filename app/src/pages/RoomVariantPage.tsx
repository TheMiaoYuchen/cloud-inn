import { useMemo, useState } from 'react';
import { previewMasterSync, selectAllSyncChanges, selectNoneSyncChanges, type SyncChange } from '../domain/design/roomSeries';
import { useGame } from '../state/GameProvider';

export function RoomVariantPage() {
  const {state,commands,error}=useGame();
  const phase2=state?.phase2,master=phase2?.roomMaster;
  const initial=useMemo(()=>master&&phase2?previewMasterSync(master,master,phase2.roomVariants):[],[master,phase2]);
  const [changes,setChanges]=useState<SyncChange[]>(initial);
  if(!master||!phase2)return <main className="page"><h1>客房系列同步</h1><p>请先创建客房母版。</p></main>;
  const toggle=(id:string)=>setChanges(items=>items.map(item=>item.id===id?{...item,selected:!item.selected}:item));
  return <main className="page"><h1>客房系列同步</h1><p>母版变化按房型、按属性逐项确认；未选择的独立设计会保留。</p><div><button onClick={()=>setChanges(selectAllSyncChanges(changes))}>全选</button><button onClick={()=>setChanges(selectNoneSyncChanges(changes))}>全不选</button></div><ul>{changes.map(change=><li key={change.id}><label><input type="checkbox" checked={change.selected} onChange={()=>toggle(change.id)}/>{phase2.roomVariants.find(item=>item.id===change.variantId)?.name} · {change.property==='gene'?'整体风格':'面积与户型'}</label></li>)}</ul><button onClick={()=>void commands.syncRoomSeries(master,changes)}>应用所选同步</button>{!changes.length&&<p>母版与变体当前一致。</p>}{error&&<p role="alert">{error}</p>}</main>;
}
