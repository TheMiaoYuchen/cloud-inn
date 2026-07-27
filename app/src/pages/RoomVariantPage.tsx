import { useMemo, useState } from 'react';
import { previewMasterSync, selectAllSyncChanges, selectNoneSyncChanges } from '../domain/design/roomSeries';
import { useGame } from '../state/GameProvider';

export function RoomVariantPage() {
  const {state,commands,error,visualProvider,visualPending}=useGame(); const phase2=state?.phase2,master=phase2?.roomMaster;
  if(!master||!phase2)return <main className="page"><h1>客房系列同步</h1><p>请先创建客房母版。</p></main>;
  return <LoadedRoomVariantPage key={`${master.id}:${master.gene.lighting}`} phase2={phase2} master={master} commands={commands} error={error} visualProvider={visualProvider} visualPending={visualPending}/>;
}

function LoadedRoomVariantPage({phase2,master,commands,error,visualProvider,visualPending}:{phase2:NonNullable<NonNullable<ReturnType<typeof useGame>['state']>['phase2']>;master:NonNullable<NonNullable<NonNullable<ReturnType<typeof useGame>['state']>['phase2']>['roomMaster']>;commands:ReturnType<typeof useGame>['commands'];error:string|null;visualProvider:ReturnType<typeof useGame>['visualProvider'];visualPending:boolean}) {
  const [lighting,setLighting]=useState(master.gene.lighting); const [selected,setSelected]=useState<Set<string>>(new Set());
  const changedMaster=useMemo(()=>master?{...master,gene:{...master.gene,lighting}}:null,[master,lighting]);
  const preview=useMemo(()=>master&&changedMaster&&phase2?previewMasterSync(master,changedMaster,phase2.roomVariants):[],[master,changedMaster,phase2]);
  if(!changedMaster)return null;
  const choices=preview.map(change=>({...change,selected:selected.has(change.id)}));
  const visuals=phase2.designVisuals;
  const focusLabels:Record<string,string>={bathroom:'浴室',lighting:'灯光',view:'景观'};
  return <main className="page"><h1>客房系列同步</h1><p>母版变化按房型、按属性逐项确认；未选择的独立设计会保留。</p><label>母版灯光<input aria-label="母版灯光" value={lighting} onChange={event=>setLighting(event.target.value)}/></label><div><button onClick={()=>setSelected(new Set(selectAllSyncChanges(preview).map(item=>item.id)))}>全选</button><button onClick={()=>{selectNoneSyncChanges(preview);setSelected(new Set())}}>全不选</button></div><ul>{choices.map(change=><li key={change.id}><label><input type="checkbox" checked={change.selected} onChange={()=>setSelected(items=>{const next=new Set(items);next.has(change.id)?next.delete(change.id):next.add(change.id);return next;})}/>{phase2.roomVariants.find(item=>item.id===change.variantId)?.name} · {change.property==='gene'?'整体风格':'面积与户型'}</label></li>)}</ul><button disabled={!choices.some(item=>item.selected)} onClick={()=>void commands.syncRoomSeries(changedMaster,choices)}>应用所选同步</button>{!preview.length&&<p>修改母版属性后可预览同步项。</p>}<ul aria-label="房型当前灯光">{phase2.roomVariants.map(variant=><li key={variant.id} data-testid={`${variant.id}-lighting`}>{variant.name} · {variant.gene.lighting}</li>)}</ul><section aria-label="客房系列效果图"><button aria-label="生成系列效果图" disabled={visualPending} onClick={()=>void commands.requestDesignVisuals(visualProvider)}>{visualPending?'生成中…':'生成系列效果图'}</button>{visuals?.assets.map(asset=>asset.request.kind==='master'?<img key="master" src={asset.assetPath} alt="客房系列主效果图"/>:<img key={`focus-${asset.request.focus}`} src={asset.assetPath} alt={`客房系列焦点效果图 · ${focusLabels[asset.request.focus]??asset.request.focus}`}/>)}</section>{visuals?.errors.length?<p role="alert">{visuals.errors.map(item=>`${item.request.kind==='master'?'主效果图':focusLabels[item.request.focus]??item.request.focus}：${item.message}`).join('；')}</p>:error&&<p role="alert">{error}</p>}</main>;
}
