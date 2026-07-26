import type { RoomMetrics } from '../../domain/game/state';
import type { StylePreset } from '../../domain/design/designTypes';

export function RoomPropertyPanel({ name, metrics, presets, selectedPreset, onName, onPreset }: {
  name: string;
  metrics: RoomMetrics | null;
  presets: ReadonlyArray<Readonly<StylePreset>>;
  selectedPreset: string;
  onName: (name: string) => void;
  onPreset: (preset: Readonly<StylePreset>) => void;
}) {
  return <aside className="property-panel" aria-label="房型属性" role="region">
    <h2>房型属性</h2>
    <label>房型名称<input aria-label="房型名称" value={name} onChange={e => onName(e.target.value)} /></label>
    <h3>整体风格</h3>
    <div className="preset-list">{presets.map(preset => <button key={preset.id} aria-pressed={selectedPreset === preset.id} onClick={() => onPreset(preset)}>{preset.name}</button>)}</div>
    <p>已选风格：{presets.find(preset => preset.id === selectedPreset)?.name ?? '未选择'}</p>
    {metrics ? <dl><div><dt>面积</dt><dd>{metrics.areaSquareMeters}㎡</dd></div><div><dt>预计造价</dt><dd>¥{metrics.buildCostCents / 100}</dd></div><div><dt>建议房价</dt><dd>¥{metrics.suggestedRateCents / 100}</dd></div><div><dt>客群适配</dt><dd>{metrics.businessFitBps / 100}%</dd></div></dl> : <p role="alert">请先绘制连续的卧室与卫浴区域</p>}
  </aside>;
}
