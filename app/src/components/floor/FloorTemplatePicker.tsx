import { createCorridorTemplate, type CorridorTemplateKind } from '../../domain/floor/corridorTemplate';

export function FloorTemplatePicker({ selected, onSelect }: { selected: CorridorTemplateKind; onSelect:(kind:CorridorTemplateKind)=>void }) {
  return <section className="template-picker"><h2>环廊模板</h2>{(['complete-ring','partial-ring'] as const).map(kind => { const template=createCorridorTemplate(kind); return <button key={kind} aria-label={template.name} aria-pressed={selected===kind} onClick={()=>onSelect(kind)}><strong>{template.name}</strong><small>{template.slots.length} 个可替换客房槽位</small></button>; })}</section>;
}
