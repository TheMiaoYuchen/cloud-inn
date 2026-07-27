import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationsState } from '../domain/operations/createOperationsState';
import type { OperationsDailyReport } from '../domain/operations/operationsTypes';
import { createNewGame, type GameState } from '../domain/game/state';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import type { SavePort } from '../application/ports/SavePort';
import { GameProvider } from '../state/GameProvider';
import { useGame } from '../state/GameProvider';
import { OperationsPage } from './OperationsPage';

const checkpoint = 1_000;

function roomState(phase: 'ready' | 'open' = 'open'): GameState {
  return {
    ...createNewGame('operations-ui'),
    revision: 1,
    phase,
    cashCents: 8_000_000,
    rateCents: 75_000,
    roomBlueprint: {
      id: 'room-type-1', name: '云岫商务房', columns: 8, rows: 12, cells: [],
      metrics: { areaSquareMeters: 36, buildCostCents: 1, suggestedRateCents: 75_000, businessFitBps: 8_000 },
      visual: { status: 'idle' },
      openings: { walls: [], doors: [], windows: [{ x: 0, y: 0, side: 'north' }] },
    },
    floor: {
      id: 'prototype-floor',
      rooms: [{ id: 'room-slot-nw', slotId: 'slot-nw', roomBlueprintId: 'room-type-1', committedBuildCostCents: 1 }],
    },
  };
}

function sampleReport(day = 7): OperationsDailyReport {
  const ids = ['business', 'couple', 'family', 'leisure', 'high-net-worth', 'cultural-experience'] as const;
  return {
    day,
    segments: ids.map((segmentId, index) => ({
      segmentId,
      demand: 6 - Math.min(index, 4),
      soldRooms: index === 0 ? 3 : 0,
      averageRateCents: index === 0 ? 82_000 : 0,
      revenueCents: index === 0 ? 246_000 : 0,
      satisfactionBps: 7_200 - index * 100,
    })),
    revenueCents: 246_000,
    operatingCostCents: 96_000,
    financeCostCents: 4_000,
    netIncomeCents: 146_000,
    endingCashCents: 8_146_000,
    reputationBps: 6_200,
    availableRooms: 4,
    soldRooms: 3,
    occupancyBps: 7_500,
    lostBookings: [
      { segmentId: 'family', code: 'hard-requirement', count: 2, explanation: '家庭客群需要三人以上入住容量' },
      { segmentId: 'leisure', code: 'price', count: 1, explanation: '当前价格超过休闲客群预算' },
    ],
    reviews: [{ segmentId: 'business', ratingBps: 7_800, text: '办公桌好用，但入住排队偏久' }],
    discoveredNeeds: [{ id: 'need-1', segmentId: 'family', kind: 'room-feature', discoveredDay: day, strengthBps: 8_000 }],
  };
}

async function portWith(state: GameState) {
  const port = new InMemorySavePort();
  await port.commit(0, state);
  return port;
}

function activeState(withReport = true): GameState {
  const state = roomState('open');
  const operations = createOperationsState('casual');
  operations.lastOfflineCheckpointMs = checkpoint;
  operations.pricePolicies['offer:room-slot-nw:room-type-1'] = {
    roomOfferId: 'offer:room-slot-nw:room-type-1',
    baseRateCents: 75_000,
    minRateCents: 60_000,
    maxRateCents: 100_000,
    automaticPricing: true,
    nightlyRateCents: 75_000,
  } as never;
  if (withReport) {
    const report = sampleReport();
    operations.dailyReports = [report];
    operations.discoveredNeeds = [...(report.discoveredNeeds ?? [])];
    state.currentDay = report.day;
  }
  return { ...state, operations };
}

afterEach(() => vi.useRealTimers());

describe('Phase 3 operations center', () => {
  it('shows actual startup offline catch-up days and a calm checkpoint notice', async () => {
    const state = activeState(false);
    const port = await portWith(state);
    function Probe() { const { startupNotice } = useGame(); return <output>{startupNotice?.message ?? '无提示'}</output>; }
    render(<GameProvider savePort={port} saveId={state.saveId} nowMs={() => 121_000} millisecondsPerGameDay={60_000}><Probe /></GameProvider>);
    expect(await screen.findByText('本次离线补算 2 天')).toBeInTheDocument();

    const checkpointState = activeState(false);
    checkpointState.operations!.lastOfflineCheckpointMs = null;
    const checkpointPort = await portWith(checkpointState);
    render(<GameProvider savePort={checkpointPort} saveId={checkpointState.saveId} nowMs={() => checkpoint} millisecondsPerGameDay={60_000}><Probe /></GameProvider>);
    expect(await screen.findByText('无需补算，已建立检查点')).toBeInTheDocument();
  });

  it('renders a readable load error instead of a blank operations page', async () => {
    const failingPort: SavePort = { load: async () => { throw new Error('桌面存档不可用'); }, commit: async () => {} };
    render(<GameProvider savePort={failingPort}><OperationsPage /></GameProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('桌面存档不可用');
    expect(screen.getByText('无法加载经营存档')).toBeInTheDocument();
  });

  it('offers one clear casual operations initialization from ready or open Phase 2 states', async () => {
    const user = userEvent.setup();
    const initial = roomState('ready');
    const port = await portWith(initial);
    render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);

    const enable = await screen.findByRole('button', { name: '启用完整经营' });
    expect(screen.getAllByRole('button')).toEqual([enable]);
    await user.click(enable);

    expect(await screen.findByRole('heading', { name: '经营结果' })).toBeInTheDocument();
    expect((await port.load(initial.saveId))?.operations?.difficulty).toBe('casual');
  });

  it('shows friendly empty results, then keeps result, reason and action regions in that order', async () => {
    const noReport = activeState(false);
    const port = await portWith(noReport);
    const view = render(<GameProvider savePort={port} saveId={noReport.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    expect(await screen.findByText('尚未营业结算')).toBeInTheDocument();
    const results = screen.getByRole('heading', { name: '经营结果' }).closest('section')!;
    for (const label of ['入住率', '平均房价', '营业收入', '净收益', '声誉', '现金', '负债']) {
      expect(within(results).getByText(label)).toBeInTheDocument();
    }

    view.unmount();
    const reported = activeState(true);
    const reportedPort = await portWith(reported);
    const rendered = render(<GameProvider savePort={reportedPort} saveId={reported.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    await screen.findByText('75%');
    const text = rendered.container.textContent ?? '';
    expect(text.indexOf('经营结果')).toBeLessThan(text.indexOf('原因诊断'));
    expect(text.indexOf('原因诊断')).toBeLessThan(text.indexOf('经营行动'));
    expect(screen.getByText('¥820')).toBeInTheDocument();
    expect(screen.getByText('家庭客群需要三人以上入住容量')).toBeInTheDocument();
    expect(screen.getByText('办公桌好用，但入住排队偏久')).toBeInTheDocument();
  });

  it('explains all six segments, hard losses and discovered needs', async () => {
    const state = activeState(true);
    render(<GameProvider savePort={await portWith(state)} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const performance = await screen.findByRole('region', { name: '客群经营表现' });
    for (const name of ['商务差旅', '情侣度假', '家庭出游', '休闲观光', '高净值宾客', '文化体验客']) {
      expect(within(performance).getByText(name)).toBeInTheDocument();
    }
    expect(within(performance).getByText(/硬性需求流失 2/)).toBeInTheDocument();
    expect(within(performance).getByText(/已发现需求/)).toBeInTheDocument();
  });

  it('edits price policy and exposes season, seven-day explanation, auto and readable errors', async () => {
    const state = activeState(true);
    const user = userEvent.setup();
    render(<GameProvider savePort={await portWith(state)} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const pricing = await screen.findByRole('region', { name: '房价策略' });
    expect(within(pricing).getAllByText(/春季/).length).toBeGreaterThan(0);
    expect(within(pricing).getAllByText(/近 ?7 日入住率/).length).toBeGreaterThan(0);
    expect(within(pricing).getByRole('checkbox', { name: '自动定价' })).toBeChecked();

    const minimum = within(pricing).getByRole('spinbutton', { name: '最低价（元）' });
    await user.clear(minimum);
    await user.type(minimum, '900');
    await user.click(within(pricing).getByRole('button', { name: '保存房价策略' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('最低价、基础价和最高价顺序无效');
  });

  it('updates all department levers and persists them across reload', async () => {
    const state = activeState(true);
    const port = await portWith(state);
    const user = userEvent.setup();
    const view = render(<GameProvider savePort={port} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const departments = await screen.findByRole('region', { name: '部门管理' });
    for (const name of ['前厅部', '客房部', '餐饮部', '工程部', '安保部', '宾客关系部']) {
      expect(within(departments).getByRole('tab', { name })).toBeInTheDocument();
    }
    await user.click(within(departments).getByRole('tab', { name: '前厅部' }));
    await user.selectOptions(within(departments).getByRole('combobox', { name: '负责人专长' }), 'arrival-flow');
    for (const [name, value] of [['员工人数', '3'], ['每日预算（元）', '200'], ['培训水平（%）', '60'], ['服务标准（%）', '75']] as const) {
      const input = within(departments).getByRole('spinbutton', { name });
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(within(departments).getByRole('button', { name: '保存部门配置' }));
    expect(await screen.findByText('前厅部配置已保存')).toBeInTheDocument();

    view.unmount();
    render(<GameProvider savePort={port} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const reloaded = await screen.findByRole('region', { name: '部门管理' });
    expect(within(reloaded).getByRole('spinbutton', { name: '员工人数' })).toHaveValue(3);
    expect(within(reloaded).getByRole('combobox', { name: '负责人专长' })).toHaveValue('arrival-flow');
  });

  it('supports difficulty, borrowing, repayment and debt visibility', async () => {
    const state = activeState(true);
    const user = userEvent.setup();
    render(<GameProvider savePort={await portWith(state)} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const finance = await screen.findByRole('region', { name: '财务管理' });
    await user.selectOptions(within(finance).getByRole('combobox', { name: '经营难度' }), 'management');
    expect(await within(finance).findByText('管理模式', { selector: 'p' })).toBeInTheDocument();
    await user.type(within(finance).getByRole('textbox', { name: '贷款名称' }), '周转贷款');
    await user.clear(within(finance).getByRole('spinbutton', { name: '贷款金额（元）' }));
    await user.type(within(finance).getByRole('spinbutton', { name: '贷款金额（元）' }), '10000');
    await user.click(within(finance).getByRole('button', { name: '申请贷款' }));
    expect(await within(finance).findByText('周转贷款')).toBeInTheDocument();
    expect(within(finance).getByText('¥10,000', { selector: '.finance-head strong' })).toBeInTheDocument();
    await user.click(within(finance).getByRole('button', { name: '偿还最低还款' }));
    expect(await within(finance).findByText(/剩余/)).toBeInTheDocument();
  });

  it('previews renovation impact before committing it', async () => {
    const state = activeState(true);
    const user = userEvent.setup();
    render(<GameProvider savePort={await portWith(state)} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const renovation = await screen.findByRole('region', { name: '客房改造' });
    await user.selectOptions(within(renovation).getByRole('combobox', { name: '改造项目' }), 'workspace');
    await user.click(within(renovation).getByRole('button', { name: '预览改造' }));
    expect(await within(renovation).findByText(/改造前/)).toBeInTheDocument();
    expect(within(renovation).getByText(/改造后/)).toBeInTheDocument();
    expect(within(renovation).getByText(/停业 2 天/)).toBeInTheDocument();
    expect(within(renovation).getByText(/客群匹配变化/)).toBeInTheDocument();
    await user.selectOptions(within(renovation).getByRole('combobox', { name: '改造项目' }), 'privacy');
    expect(within(renovation).queryByText(/改造前/)).not.toBeInTheDocument();
    await user.click(within(renovation).getByRole('button', { name: '预览改造' }));
    expect(within(renovation).getByText(/改造前：.*私密性/)).toBeInTheDocument();
    expect(within(renovation).getByText(/改造后：.*私密性/)).toBeInTheDocument();
    await user.click(within(renovation).getByRole('button', { name: '确认改造' }));
    expect(await within(renovation).findByText('私密性改造 1 级已安排 · 剩余停业 2 天')).toBeInTheDocument();
    await user.selectOptions(within(renovation).getByRole('combobox', { name: '改造项目' }), 'view');
    expect(within(renovation).queryByText(/已安排/)).not.toBeInTheDocument();
  });

  it('shows timeline, offline checkpoint and deterministic time controls through day thirty', async () => {
    const state = activeState(true);
    state.operations!.weeklyReports = [{
      week: 1, startDay: 1, endDay: 7, revenueCents: 1_000_000, netIncomeCents: 400_000,
      averageOccupancyBps: 7_000, reputationBps: 6_000,
      topResultCode: 'segment:business', topReasonCode: 'price', suggestedActionCode: 'adjust-pricing',
    }];
    state.operations!.monthlyCloses = [{
      month: 1, startDay: 1, endDay: 30, revenueCents: 4_000_000, netIncomeCents: 1_200_000,
      debtPaymentCents: 100_000, reputationBps: 7_000, endingCashCents: 9_000_000,
      topResultCode: 'segment:business', topReasonCode: 'service', suggestedActionCode: 'improve-service-capacity',
    }];
    const user = userEvent.setup();
    render(<GameProvider savePort={await portWith(state)} saveId={state.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    const timeline = await screen.findByRole('region', { name: '经营报告时间线' });
    for (const text of ['原因：价格流失', '行动：调整房价']) {
      expect(within(timeline).getByText(text, { exact: false })).toBeInTheDocument();
    }
    for (const heading of ['日报', '周报', '月结']) expect(within(timeline).getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(within(timeline).getAllByText('结果：商务差旅表现最佳')).toHaveLength(2);
    expect(screen.getByText('离线结算最多 7 天')).toBeInTheDocument();
    expect(screen.getByText(/检查点.*已记录/)).toBeInTheDocument();
    for (const name of ['暂停', '1 倍速', '2 倍速', '4 倍速', '推进一天']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: '推进一天' }));
    expect(await screen.findByText('营业日 8 / 30')).toBeInTheDocument();

    const finished: GameState = { ...state, currentDay: 30, operations: { ...state.operations!, timeSpeed: 0 } };
    const finishedView = render(<GameProvider savePort={await portWith(finished)} saveId={finished.saveId} nowMs={() => checkpoint}><OperationsPage /></GameProvider>);
    expect(await screen.findByText('30 日经营周期已完成')).toBeInTheDocument();
    const advances = screen.getAllByRole('button', { name: '推进一天' });
    expect(advances[advances.length - 1]).toBeDisabled();
    finishedView.unmount();
  });
});
