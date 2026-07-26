import type { CorridorAnalysis } from '../../domain/floor/corridorTemplate';

export function FloorHintPanel({ analysis }: { analysis:CorridorAnalysis }) {
  return <aside className="floor-hints" aria-label="规划提示" role="region"><h2>规划提示</h2><p>最远服务距离 {Math.max(...Object.values(analysis.serviceDistances))} 格</p><p>最高动线重叠 {analysis.maxCongestion} 条</p>{analysis.hints.length ? analysis.hints.map(hint=><p key={`${hint.kind}-${hint.message}`}>{hint.message}</p>) : <p>当前环廊连通良好，无强制整改项。</p>}<small>提示仅辅助规划，不直接改变收入或成本。</small></aside>;
}
