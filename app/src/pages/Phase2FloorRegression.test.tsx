import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FloorPlanningPage } from './FloorPlanningPage';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type GameState, type ZoneKind } from '../domain/game/state';
import { CONTEMPORARY_ORIENTAL } from '../domain/design/stylePresets';
import { createRoomMaster, createRoomVariants } from '../domain/design/roomSeries';

async function floorPort() {
  const port = new InMemorySavePort();
  const master = createRoomMaster({ id:'master', name:'云岫客房', columns:8, rows:12, gene:CONTEMPORARY_ORIENTAL.gene, cells:Array.from({length:96},(_,i)=>({x:i%8,y:Math.floor(i/8),zone:(i<64?'bedroom':'bathroom') as ZoneKind})) });
  const state: GameState = { ...createNewGame('floor-save'), revision:1, phase:'floor', roomBlueprint:master, phase2:{ hotelGene:master.gene, roomMaster:master, roomVariants:createRoomVariants(master), corridorTemplate:null } };
  await port.commit(0, state); return port;
}

describe('phase two floor planning', () => {
  it('shows template selection, square ring corridor, true-size slots, and hints', async () => {
    render(<GameProvider savePort={await floorPort()} saveId="floor-save"><FloorPlanningPage /></GameProvider>);
    expect(await screen.findByRole('heading', { name:'高层酒店楼层规划' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name:'完整方形环廊' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name:'南侧开口环廊' })).toBeInTheDocument();
    expect(screen.getByLabelText('方形环廊楼层总览')).toBeInTheDocument();
    expect(screen.getByText('核心筒')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/房间槽位/).length).toBeGreaterThan(4);
    expect(screen.getByRole('region', { name:'规划提示' })).toBeInTheDocument();
  });
});
