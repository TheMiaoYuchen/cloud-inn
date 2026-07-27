import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameProvider, useGame } from './GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { RoomDesignPage } from '../pages/RoomDesignPage';
import type { SavePort } from '../application/ports/SavePort';
import { createNewGame, type GameState } from '../domain/game/state';
import { createOperationsState } from '../domain/operations/createOperationsState';

afterEach(() => vi.useRealTimers());

describe('GameProvider flow', () => {
  it('exposes visualPending independently while a visual request is queued', async () => {
    const port = new InMemorySavePort();
    const initial: GameState = {
      ...createNewGame('save-1'), revision: 1, phase: 'floor',
      roomBlueprint: { id: 'room-type-1', name: 'Suite', columns: 8, rows: 12, cells: [], metrics: { areaSquareMeters: 24, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 }, visual: { status: 'idle' } },
    };
    await port.commit(0, initial);
    let release!: () => void;
    const visualProvider = { generate: async () => new Promise<{ assetPath: string }>((resolve) => { release = () => resolve({ assetPath: '/visuals/asset.svg' }); }) };
    function Probe() { const { visualPending, commandPending, commands } = useGame(); return <><span>{visualPending ? 'visual-busy' : 'visual-idle'}</span><span>{commandPending ? 'busy' : 'idle'}</span><button onClick={() => void commands.requestVisual(visualProvider)}>request</button></>; }
    const user = userEvent.setup();
    render(<GameProvider savePort={port} visualProvider={visualProvider}><Probe /></GameProvider>);
    await screen.findByText('visual-idle');
    await user.click(screen.getByRole('button', { name: 'request' }));
    expect(screen.getByText('visual-busy')).toBeInTheDocument();
    expect(screen.getByText('busy')).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByText('visual-idle')).toBeInTheDocument();
  });
  it('restores a saved room blueprint as the editor draft on bootstrap', async () => {
    const port = new InMemorySavePort();
    const saved: GameState = {
      ...createNewGame('save-1'),
      revision: 1,
      phase: 'floor',
      roomBlueprint: {
        id: 'room-type-1', name: '云岫套房', columns: 8, rows: 12,
        cells: [{ x: 1, y: 2, zone: 'bathroom' }],
        metrics: { areaSquareMeters: 1, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 },
        visual: { status: 'idle' },
      },
    };
    await port.commit(0, saved);

    function DraftProbe() {
      const { draft } = useGame();
      return <output data-testid="draft">{JSON.stringify({ name: draft.name, cells: draft.cells })}</output>;
    }

    render(<GameProvider savePort={port}><DraftProbe /></GameProvider>);

    expect(await screen.findByTestId('draft')).toHaveTextContent(JSON.stringify({
      name: '云岫套房', cells: [{ x: 1, y: 2, zone: 'bathroom' }],
    }));
  });

  it('renders design and transitions to floor', async () => {
    const port = new InMemorySavePort();
    const user = userEvent.setup();
    render(<GameProvider savePort={port}><RoomDesignPage /></GameProvider>);
    expect(await screen.findByText('设计你的第一间客房')).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name:'云岫商务房'}));
    await user.click(await screen.findByRole('button', {name:'保存并进入楼层'}));
    expect(await screen.findByText('固定楼层槽位')).toBeInTheDocument();
  });
  it('shows empty name error', async () => {
    const user = userEvent.setup(); const port = new InMemorySavePort();
    render(<GameProvider savePort={port}><RoomDesignPage /></GameProvider>);
    await user.click(await screen.findByRole('button', {name:'保存并进入楼层'}));
    expect(await screen.findByText('房型名称不能为空')).toBeInTheDocument();
  });

  it('blocks play and shows the load error when an explicit save port fails', async () => {
    const failingPort: SavePort = {
      load: async () => { throw new Error('桌面存档不可用'); },
      commit: async () => { throw new Error('unexpected commit'); },
    };

    render(<GameProvider savePort={failingPort}><RoomDesignPage /></GameProvider>);

    expect(await screen.findByRole('alert')).toHaveTextContent('桌面存档不可用');
    expect(screen.queryByText('设计你的第一间客房')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存并进入楼层' })).not.toBeInTheDocument();
  });

  it('keeps commands pending until every queued commit finishes', async () => {
    const initial: GameState = {
      ...createNewGame('save-1'),
      revision: 1,
      phase: 'ready',
      roomBlueprint: {
        id: 'room-type-1', name: 'Suite', columns: 8, rows: 12, cells: [],
        metrics: { areaSquareMeters: 24, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 },
        visual: { status: 'idle' },
      },
    };
    const releases: Array<() => void> = [];
    const port: SavePort = {
      load: async () => initial,
      commit: async () => new Promise<void>((resolve) => releases.push(resolve)),
    };
    function QueueProbe() {
      const { commandPending, commands } = useGame();
      return <><span>{commandPending ? 'busy' : 'idle'}</span><button onClick={() => {
        void commands.setRate(200);
        void commands.setRate(300);
      }}>queue</button></>;
    }
    const user = userEvent.setup();
    render(<GameProvider savePort={port}><QueueProbe /></GameProvider>);
    await screen.findByText('idle');

    await user.click(screen.getByRole('button', { name: 'queue' }));
    expect(screen.getByText('busy')).toBeInTheDocument();
    await act(async () => releases[0]());
    await act(async () => {});

    expect(releases).toHaveLength(2);
    expect(screen.getByText('busy')).toBeInTheDocument();
    await act(async () => releases[1]());
    expect(await screen.findByText('idle')).toBeInTheDocument();
  });

  it('establishes a startup checkpoint without inventing elapsed time when none exists', async () => {
    const port = new InMemorySavePort();
    const initial = {
      ...createNewGame('save-startup-checkpoint'),
      revision: 1,
      operations: createOperationsState(),
    };
    await port.commit(0, initial);
    function Probe() {
      const { state } = useGame();
      return <output>{JSON.stringify({ day: state?.currentDay, checkpoint: state?.operations?.lastOfflineCheckpointMs })}</output>;
    }

    render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => 50_000}><Probe /></GameProvider>);

    expect(await screen.findByText(JSON.stringify({ day: 0, checkpoint: 50_000 }))).toBeInTheDocument();
    expect((await port.load(initial.saveId))?.operations?.lastOfflineCheckpointMs).toBe(50_000);
  });

  it('atomically settles startup elapsed days before exposing loaded operations state', async () => {
    const port = new InMemorySavePort();
    const operations = createOperationsState();
    operations.lastOfflineCheckpointMs = 1_000;
    const initial: GameState = {
      ...createNewGame('save-startup-catch-up'),
      revision: 1,
      phase: 'open',
      roomBlueprint: { id: 'room-type-1', name: 'Suite', columns: 8, rows: 12, cells: [], metrics: { areaSquareMeters: 24, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 }, visual: { status: 'idle' } },
      floor: { id: 'prototype-floor', rooms: [{ id: 'room-slot-nw', slotId: 'slot-nw', roomBlueprintId: 'room-type-1', committedBuildCostCents: 1 }] },
      operations,
    };
    await port.commit(0, initial);
    const exposed: number[] = [];
    function Probe() {
      const { state, loading } = useGame();
      if (!loading && state) exposed.push(state.currentDay);
      return <output>{state ? `${state.currentDay}:${state.operations?.lastOfflineCheckpointMs}` : 'none'}</output>;
    }

    render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => 121_000} millisecondsPerGameDay={60_000}><Probe /></GameProvider>);

    expect(await screen.findByText('2:121000')).toBeInTheDocument();
    expect(exposed).toEqual([2]);
    const saved = await port.load(initial.saveId);
    expect(saved?.currentDay).toBe(2);
    expect(saved?.operations?.dailyReports).toHaveLength(2);
    expect(saved?.revision).toBe(2);
  });

  it('serializes live clock advances without duplicate dispatches', async () => {
    vi.useFakeTimers();
    const operations = createOperationsState();
    operations.timeSpeed = 4;
    operations.lastOfflineCheckpointMs = 0;
    const initial: GameState = {
      ...createNewGame('save-provider-clock'), revision: 1, phase: 'open', operations,
      roomBlueprint: { id: 'room-type-1', name: 'Suite', columns: 8, rows: 12, cells: [], metrics: { areaSquareMeters: 24, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 }, visual: { status: 'idle' } },
      floor: { id: 'prototype-floor', rooms: [{ id: 'room-slot-nw', slotId: 'slot-nw', roomBlueprintId: 'room-type-1', committedBuildCostCents: 1 }] },
    };
    let release!: () => void;
    let commits = 0;
    const port: SavePort = {
      load: async () => initial,
      commit: async () => {
        commits += 1;
        if (commits === 1) await new Promise<void>((resolve) => { release = resolve; });
      },
    };
    function Probe() { const { state } = useGame(); return <output>{state?.currentDay ?? 'loading'}</output>; }
    render(<GameProvider savePort={port} nowMs={() => 0}><Probe /></GameProvider>);
    await act(async () => {});

    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(commits).toBe(1);
    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(commits).toBe(2);
  });

  it('checkpoints visibility suspension through the same queued command path', async () => {
    const port = new InMemorySavePort();
    const operations = createOperationsState();
    operations.lastOfflineCheckpointMs = 100;
    const initial = { ...createNewGame('save-provider-hidden'), revision: 1, operations };
    await port.commit(0, initial);
    const values = [100, 200];
    render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => values.shift() ?? 200}><div>ready</div></GameProvider>);
    await screen.findByText('ready');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {});

    expect((await port.load(initial.saveId))?.operations?.lastOfflineCheckpointMs).toBe(200);
  });

  it('supplies application time to a manual day advance in the same commit', async () => {
    const port = new InMemorySavePort();
    const operations = createOperationsState();
    operations.lastOfflineCheckpointMs = 100;
    const initial: GameState = {
      ...createNewGame('save-provider-manual'), revision: 1, phase: 'open', operations,
      roomBlueprint: { id: 'room-type-1', name: 'Suite', columns: 8, rows: 12, cells: [], metrics: { areaSquareMeters: 24, buildCostCents: 1, suggestedRateCents: 1, businessFitBps: 1 }, visual: { status: 'idle' } },
      floor: { id: 'prototype-floor', rooms: [{ id: 'room-slot-nw', slotId: 'slot-nw', roomBlueprintId: 'room-type-1', committedBuildCostCents: 1 }] },
    };
    await port.commit(0, initial);
    const values = [100, 500];
    function Probe() {
      const { state, commands } = useGame();
      return <><output>{`${state?.currentDay}:${state?.operations?.lastOfflineCheckpointMs}`}</output><button onClick={() => void commands.advanceDay()}>advance</button></>;
    }
    const user = userEvent.setup();
    const firstRender = render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => values.shift() ?? 500}><Probe /></GameProvider>);
    await screen.findByText('0:100');

    await user.click(screen.getByRole('button', { name: 'advance' }));

    expect(await screen.findByText('1:500')).toBeInTheDocument();
    const saved = await port.load(initial.saveId);
    expect(saved?.currentDay).toBe(1);
    expect(saved?.operations?.lastOfflineCheckpointMs).toBe(500);
    expect(saved?.revision).toBe(2);

    firstRender.unmount();
    render(<GameProvider savePort={port} saveId={initial.saveId} nowMs={() => 500}><Probe /></GameProvider>);
    expect(await screen.findByText('1:500')).toBeInTheDocument();
    expect((await port.load(initial.saveId))?.revision).toBe(2);
  });
});
