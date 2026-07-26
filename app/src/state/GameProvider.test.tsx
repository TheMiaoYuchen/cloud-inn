import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GameProvider, useGame } from './GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { RoomDesignPage } from '../pages/RoomDesignPage';
import type { SavePort } from '../application/ports/SavePort';
import { createNewGame, type GameState } from '../domain/game/state';

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
});
