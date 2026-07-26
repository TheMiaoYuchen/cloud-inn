export type EditorTool='paint'|'erase'|'rectangle'|'select'|'wall'|'door'|'window';
export function RoomToolRail({ activeZone, tool, onZone, onTool }: { activeZone:'bedroom'|'bathroom'; tool:EditorTool; onZone:(zone:'bedroom'|'bathroom')=>void; onTool:(tool:EditorTool)=>void }) {
  const tools:Array<[EditorTool,string]>=[['paint','画笔'],['erase','橡皮'],['rectangle','矩形'],['select','选择'],['wall','墙体'],['door','门'],['window','窗']];
  return <aside className="tool-rail" aria-label="房型工具" role="region"><h2>绘制</h2><button aria-pressed={activeZone==='bedroom'} onClick={()=>onZone('bedroom')}>卧室</button><button aria-pressed={activeZone==='bathroom'} onClick={()=>onZone('bathroom')}>卫浴</button><hr/>{tools.map(([id,label])=><button key={id} aria-pressed={tool===id} onClick={()=>onTool(id)}>{label}</button>)}</aside>;
}
