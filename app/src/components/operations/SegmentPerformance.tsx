import { GUEST_SEGMENTS } from '../../domain/operations/segmentCatalog';
import type { DiscoveredMarketNeed, OperationsDailyReport } from '../../domain/operations/operationsTypes';
import { money } from './OperationsSummary';

const needLabels = { 'room-feature': '客房功能', service: '服务体验', price: '价格接受度' } as const;

export function SegmentPerformance({ report, discoveredNeeds }: { report?: OperationsDailyReport; discoveredNeeds: DiscoveredMarketNeed[] }) {
  return <section className="diagnosis-card segment-performance" aria-label="客群经营表现">
    <h3>六类客群表现</h3><p className="muted">需求、成交与真正流失原因均来自已结算日报。</p>
    <div className="segment-grid">{GUEST_SEGMENTS.map(segment => {
      const result = report?.segments.find(item => item.segmentId === segment.id);
      const hardLost = report?.lostBookings?.filter(item => item.segmentId === segment.id && item.code === 'hard-requirement').reduce((sum, item) => sum + item.count, 0) ?? 0;
      const needs = discoveredNeeds.filter(item => item.segmentId === segment.id);
      return <article key={segment.id}><h4>{segment.displayName}</h4><dl><div><dt>需求 / 成交</dt><dd>{result ? `${result.demand} / ${result.soldRooms}` : '—'}</dd></div><div><dt>客房收入</dt><dd>{result ? money(result.revenueCents) : '—'}</dd></div><div><dt>满意度</dt><dd>{result ? `${result.satisfactionBps / 100}%` : '—'}</dd></div></dl>{hardLost > 0 && <p className="warning-chip">硬性需求流失 {hardLost}</p>}{needs.map(need => <p className="need-chip" key={need.id}>已发现需求：{needLabels[need.kind]} · {need.strengthBps / 100}%</p>)}</article>;
    })}</div>
  </section>;
}
