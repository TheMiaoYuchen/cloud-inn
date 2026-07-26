import type { CorridorTemplate, RoomVariant } from '../../domain/design/designTypes';

export function FloorOverview({ template, variants }: { template:CorridorTemplate; variants:RoomVariant[] }) {
  return <section className="square-floor" aria-label="方形环廊楼层总览"><div className="core-tower">核心筒<span>电梯 · 后勤</span></div><div className="ring-corridor">方形环廊</div>{template.slots.map((slot,index) => { const variant=variants[index%Math.max(variants.length,1)]; return <button key={slot.id} aria-label={`房间槽位 ${slot.id}`} className="true-size-slot" style={{ left:`${slot.anchor.x/template.width*100}%`, top:`${slot.anchor.y/template.height*100}%`, width:`${slot.width/template.width*100}%`, height:`${slot.height/template.height*100}%` }}><strong>{variant?.name ?? '待选房型'}</strong><small>{slot.width}×{slot.height}m</small></button>; })}</section>;
}
