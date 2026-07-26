export function RoomToolRail({ activeZone, tool, onZone, onTool }: {
  activeZone: 'bedroom' | 'bathroom';
  tool: 'paint' | 'erase' | 'rectangle';
  onZone: (zone: 'bedroom' | 'bathroom') => void;
  onTool: (tool: 'paint' | 'erase' | 'rectangle') => void;
}) {
  return <aside className="tool-rail" aria-label="房型工具" role="region">
    <h2>绘制</h2>
    <button aria-pressed={activeZone === 'bedroom'} onClick={() => onZone('bedroom')}>卧室</button>
    <button aria-pressed={activeZone === 'bathroom'} onClick={() => onZone('bathroom')}>卫浴</button>
    <hr />
    <button aria-pressed={tool === 'paint'} onClick={() => onTool('paint')}>画笔</button>
    <button aria-pressed={tool === 'erase'} onClick={() => onTool('erase')}>橡皮</button>
    <button aria-pressed={tool === 'rectangle'} onClick={() => onTool('rectangle')}>矩形</button>
  </aside>;
}
