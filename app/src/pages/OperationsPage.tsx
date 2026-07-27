import { Link } from 'react-router-dom';
import { previewRoomRenovation } from '../application/gameCommands';
import { DepartmentPanel } from '../components/operations/DepartmentPanel';
import { FinancePanel } from '../components/operations/FinancePanel';
import { OperationsSummary } from '../components/operations/OperationsSummary';
import { PricingPanel } from '../components/operations/PricingPanel';
import { RenovationPanel } from '../components/operations/RenovationPanel';
import { ReportTimeline } from '../components/operations/ReportTimeline';
import { SegmentPerformance } from '../components/operations/SegmentPerformance';
import { seasonForGameDay, type PricingContext } from '../domain/operations/pricing';
import { projectRoomOffers } from '../domain/operations/roomOffer';
import type { Difficulty, OperationsDailyReport } from '../domain/operations/operationsTypes';
import type { GameState } from '../domain/game/state';
import { useGame } from '../state/GameProvider';

const clampBps = (value: number) => Math.max(0, Math.min(10_000, Math.trunc(value)));

function pricingContext(state: GameState): PricingContext {
  const recent = state.operations?.dailyReports.slice(-7) ?? [];
  const available = recent.reduce((sum, item) => sum + (item.availableRooms ?? 0), 0);
  const sold = recent.reduce((sum, item) => sum + (item.soldRooms ?? 0), 0);
  const demand = recent.reduce((sum, item) => sum + item.segments.reduce((day, segment) => day + segment.demand, 0), 0);
  const latest = recent[recent.length - 1];
  const latestAvailable = latest?.availableRooms ?? 0;
  return {
    season: seasonForGameDay(state.currentDay),
    trailingSevenDayOccupancyBps: available ? clampBps((sold * 10_000) / available) : 5_000,
    segmentDemandBps: recent.length && state.floor.rooms.length ? clampBps((demand * 10_000) / (recent.length * state.floor.rooms.length)) : 5_000,
    reputationBps: clampBps(state.operations?.reputationBps ?? 5_000),
    remainingInventoryBps: latestAvailable ? clampBps(((latestAvailable - (latest?.soldRooms ?? 0)) * 10_000) / latestAvailable) : 5_000,
  };
}

function reasonCards(report?: OperationsDailyReport) {
  if (!report) return [{ title: '尚无经营原因', body: '推进首个营业日后，将根据真实流失、评价与服务表现解释结果。' }];
  const lost = [...(report.lostBookings ?? [])].sort((a, b) => b.count - a.count).slice(0, 2).map(item => ({ title: `流失 ${item.count} 单`, body: item.explanation }));
  const reviews = (report.reviews ?? []).slice(0, 2).map(item => ({ title: `宾客评价 ${item.ratingBps / 100}%`, body: item.text }));
  return [...lost, ...reviews].length ? [...lost, ...reviews] : [{ title: '经营平稳', body: '本日没有显著流失原因，建议保持策略并继续观察。' }];
}

export function OperationsPage() {
  const { state, loading, error, startupNotice, commandPending, commands } = useGame();
  if (loading) return <main className="page operations-gate"><p>正在加载经营存档…</p></main>;
  if (!state && error) return <main className="page operations-gate"><h1>无法加载经营存档</h1><p>请检查存档后重试。</p><p role="alert">{error}</p></main>;
  if (!state) return <main className="page operations-gate"><p>暂无经营数据。</p></main>;
  if (state.phase === 'design' || state.phase === 'floor') return <main className="page operations-gate"><p>请先完成客房设计与楼层施工。</p><Link to="/floor-plan">前往楼层</Link></main>;
  if (!state.operations) return <main className="page operations-gate"><p className="eyebrow">PHASE 3 · OPERATIONS</p><h1>完整经营中心</h1><p>把客房、客群、部门与资金放进同一套可解释的经营循环。</p><button disabled={commandPending} onClick={() => void commands.initializeOperations('casual')}>启用完整经营</button>{error && <p role="alert">{error}</p>}</main>;

  const operations = state.operations;
  const report = operations.dailyReports[operations.dailyReports.length - 1];
  const offers = projectRoomOffers(state);
  const finished = state.currentDay >= 30;
  return <main className="page operations-page">
    <header className="operations-header"><div><p className="eyebrow">OPERATIONS CENTER</p><h1>云岫经营中心</h1><p>先看结果，再找原因，最后行动。</p></div><div className="day-status"><strong>营业日 {state.currentDay} / 30</strong><span>{state.phase === 'open' ? '● 营业中' : '○ 待开业'}</span></div></header>
    <OperationsSummary report={report} cashCents={state.cashCents} loans={operations.loans} reputationBps={operations.reputationBps} />
    <p className="muted">已解锁内容：{operations.unlockedContent.length ? operations.unlockedContent.join('、') : '暂无'}</p>
    {Object.values(operations.offerUpgrades).map(upgrade => <p className="muted" key={`${upgrade.roomOfferId}-${upgrade.upgradeId}`}>{upgrade.upgradeId === 'workspace' ? '办公空间改造' : upgrade.upgradeId} {upgrade.level} 级 · 剩余停业 {upgrade.remainingClosureDays ?? 0} 天</p>)}
    {startupNotice && <p className="startup-notice" role="status">{startupNotice.message}</p>}
    <section className="operations-section reason-section" aria-labelledby="operations-reason-title"><div className="section-heading"><span>02</span><div><h2 id="operations-reason-title">原因诊断</h2><p>找到影响经营结果的主要因素</p></div></div><div className="reason-layout"><div className="reason-cards">{reasonCards(report).map((item, index) => <article key={`${item.title}-${index}`}><small>关键原因 {index + 1}</small><h3>{item.title}</h3><p>{item.body}</p></article>)}</div><SegmentPerformance report={report} discoveredNeeds={operations.discoveredNeeds} /></div></section>
    <section className="operations-section action-section" aria-labelledby="operations-action-title"><div className="section-heading"><span>03</span><div><h2 id="operations-action-title">经营行动</h2><p>调整策略会进入同一条安全保存队列</p></div></div><div className="action-workspace"><div className="action-primary"><PricingPanel offers={offers} policies={operations.pricePolicies} context={pricingContext(state)} pending={commandPending || finished} onSave={policy => commands.setRoomPricePolicy(policy)} onAuto={(id, enabled) => commands.setAutomaticPricing(id, enabled)} /><RenovationPanel offer={offers[0]} pending={commandPending || finished} onPreview={request => previewRoomRenovation(state, request)} onRenovate={request => commands.renovateRoomOffer(request)} /><DepartmentPanel departments={operations.departments} pending={commandPending || finished} onSave={input => commands.configureDepartment(input)} /></div><FinancePanel difficulty={operations.difficulty} cashCents={state.cashCents} loans={operations.loans} pending={commandPending} onDifficulty={(value: Difficulty) => commands.setDifficulty(value)} onTakeLoan={request => commands.takeLoan(request)} onRepay={(id, amount) => commands.repayLoan(id, amount)} /></div></section>
    <section className="time-console" aria-label="经营时间控制"><div><h3>{finished ? '30 日经营周期已完成' : '经营时间'}</h3><p>{finished ? '查看月结并复盘经营策略。' : '自动速度与手动推进共用串行日结。'}</p></div><div className="speed-controls">{([0, 1, 2, 4] as const).map(speed => <button aria-pressed={operations.timeSpeed === speed} disabled={commandPending || finished || state.phase !== 'open'} key={speed} onClick={() => void commands.setTimeSpeed(speed)}>{speed === 0 ? '暂停' : `${speed} 倍速`}</button>)}{state.phase === 'ready' && <button disabled={commandPending} onClick={() => void commands.openHotel()}>开始营业</button>}<button disabled={commandPending || finished || state.phase !== 'open'} onClick={() => void commands.advanceDay()}>推进一天</button></div></section>
    {error && <p className="command-error" role="alert"><strong>操作未完成：</strong>{error}</p>}
    <ReportTimeline daily={operations.dailyReports} weekly={operations.weeklyReports} monthly={operations.monthlyCloses} checkpointMs={operations.lastOfflineCheckpointMs} />
  </main>;
}
