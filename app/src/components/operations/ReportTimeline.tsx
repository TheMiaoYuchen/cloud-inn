import type { MonthlyOperationsClose, OperationsDailyReport, WeeklyOperationsReport } from '../../domain/operations/operationsTypes';
import { GUEST_SEGMENTS } from '../../domain/operations/segmentCatalog';
import { money } from './OperationsSummary';

const reason = { 'hard-requirement': '客房硬性需求不符', price: '价格流失', service: '服务能力不足', 'no-inventory': '库存不足', none: '经营平稳' } as const;
const action: Record<string, string> = { 'improve-room-offer': '升级客房产品', 'adjust-pricing': '调整房价', 'improve-service-capacity': '改善服务能力', 'expand-inventory': '扩充库存', 'maintain-operations': '保持当前策略' };
const resultText = (code?: string) => {
  const id = code?.replace('segment:', '');
  return `${GUEST_SEGMENTS.find(item => item.id === id)?.displayName ?? '整体经营'}表现最佳`;
};
const categoryText = (report: OperationsDailyReport | WeeklyOperationsReport | MonthlyOperationsClose) =>
  report.roomRevenueCents === undefined ? null : <span>客房收入 {money(report.roomRevenueCents)} · 公共空间收入 {money(report.publicSpaceRevenueCents ?? 0)} · 部门成本 {money(report.departmentCostCents ?? 0)} · 设施成本 {money(report.facilityOperatingCostCents ?? 0)}</span>;

export function ReportTimeline({ daily, weekly, monthly, checkpointMs }: { daily: OperationsDailyReport[]; weekly: WeeklyOperationsReport[]; monthly: MonthlyOperationsClose[]; checkpointMs: number | null }) {
  return <section aria-label="经营报告时间线" className="report-timeline"><div className="timeline-heading"><div><h3>经营报告时间线</h3><p>日报 {daily.length} · 周报 {weekly.length} · 月结 {monthly.length}</p></div><aside><strong>离线结算最多 7 天</strong><span>检查点：{checkpointMs === null ? '待首次记录' : '已记录'}</span></aside></div>
    <div className="timeline-groups"><article aria-label="日报"><h4>日报</h4>{daily.length ? daily.slice(-3).reverse().map(item => <div className="timeline-entry" key={item.day}><strong>第 {item.day} 日 · {money(item.netIncomeCents)}</strong>{categoryText(item)}<span>结果：入住率 {(item.occupancyBps ?? 0) / 100}%</span><span>原因：{item.lostBookings?.[0]?.explanation ?? '暂无明显流失'}</span><span>行动：关注主要客群反馈</span></div>) : <p>结算后生成日报</p>}</article>
      <article aria-label="周报"><h4>周报</h4>{weekly.length ? weekly.slice(-2).reverse().map(item => <div className="timeline-entry" key={item.week}><strong>第 {item.week} 周 · {money(item.netIncomeCents)}</strong>{categoryText(item)}<span>结果：{resultText(item.topResultCode)}</span><span>原因：{reason[item.topReasonCode ?? 'none']}</span><span>行动：{action[item.suggestedActionCode ?? ''] ?? '保持当前策略'}</span></div>) : <p>每 7 天生成周报</p>}</article>
      <article aria-label="月结"><h4>月结</h4>{monthly.length ? monthly.slice(-1).map(item => <div className="timeline-entry" key={item.month}><strong>第 {item.month} 月 · {money(item.netIncomeCents)}</strong>{categoryText(item)}<span>结果：{resultText(item.topResultCode)}</span><span>原因：{reason[item.topReasonCode ?? 'none']}</span><span>行动：{action[item.suggestedActionCode ?? ''] ?? '保持当前策略'}</span></div>) : <p>第 30 天生成月结</p>}</article></div>
  </section>;
}
