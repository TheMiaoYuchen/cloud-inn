import type { LoanState, OperationsDailyReport } from '../../domain/operations/operationsTypes';

export const money = (cents: number) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
}).format(cents / 100);

export function OperationsSummary({ report, cashCents, loans, reputationBps }: {
  report?: OperationsDailyReport;
  cashCents: number;
  loans: LoanState[];
  reputationBps: number;
}) {
  const sold = report?.segments.reduce((sum, item) => sum + item.soldRooms, 0) ?? 0;
  const revenue = report?.segments.reduce((sum, item) => sum + item.revenueCents, 0) ?? 0;
  const adr = sold ? Math.trunc(revenue / sold) : null;
  const occupancy = report?.occupancyBps ?? (report?.availableRooms ? Math.trunc(((report.soldRooms ?? sold) * 10_000) / report.availableRooms) : null);
  const debt = loans.reduce((sum, loan) => sum + loan.outstandingCents, 0);
  const cards = [
    ['入住率', occupancy === null ? '—' : `${occupancy / 100}%`],
    ['平均房价', adr === null ? '—' : money(adr)],
    ['营业收入', report ? money(report.revenueCents) : '—'],
    ['净收益', report ? money(report.netIncomeCents) : '—'],
    ['声誉', `${(report?.reputationBps ?? reputationBps) / 100} 分`],
    ['现金', money(cashCents)],
    ['负债', money(debt)],
  ];
  return <section aria-labelledby="operations-result-title" className="operations-section result-section">
    <div className="section-heading"><span>01</span><div><h2 id="operations-result-title">经营结果</h2><p>先看今天发生了什么</p></div></div>
    {!report && <p className="empty-state">尚未营业结算</p>}
    <div className="metric-grid">{cards.map(([label, value]) => <article className="metric-card" key={label}><small>{label}</small><strong>{value}</strong></article>)}</div>
  </section>;
}
