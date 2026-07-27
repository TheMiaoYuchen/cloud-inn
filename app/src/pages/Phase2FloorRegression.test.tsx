import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FloorPlanningPage } from './FloorPlanningPage';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type GameState, type ZoneKind } from '../domain/game/state';
import { CONTEMPORARY_ORIENTAL } from '../domain/design/stylePresets';
import { createRoomMaster, createRoomVariants } from '../domain/design/roomSeries';
import { createCorridorTemplate } from '../domain/floor/corridorTemplate';

async function floorPort() {
  const port = new InMemorySavePort();
  const master = createRoomMaster({ id:'master', name:'云岫客房', columns:8, rows:12, gene:CONTEMPORARY_ORIENTAL.gene, cells:Array.from({length:96},(_,i)=>({x:i%8,y:Math.floor(i/8),zone:(i<64?'bedroom':'bathroom') as ZoneKind})) });
  const state: GameState = { ...createNewGame('floor-save'), revision:1, phase:'floor', roomBlueprint:master, phase2:{ hotelGene:master.gene, roomMaster:master, roomVariants:createRoomVariants(master), corridorTemplate:createCorridorTemplate('complete-ring') } };
  await port.commit(0, state); return port;
}

describe('phase two floor planning', () => {
  it('shows template selection, square ring corridor, true-size slots, and hints', async () => {
    const user=userEvent.setup();
    render(<GameProvider savePort={await floorPort()} saveId="floor-save"><FloorPlanningPage /></GameProvider>);
    expect(await screen.findByRole('heading', { name:'高层酒店楼层规划' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name:'完整方形环廊' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name:'南侧开口环廊' })).toBeInTheDocument();
    expect(screen.getByLabelText('方形环廊楼层总览')).toBeInTheDocument();
    expect(screen.getByText('核心筒')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/房间槽位/).length).toBeGreaterThan(4);
    expect(screen.getByRole('region', { name:'规划提示' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('替换房型'),'master-corner');
    await user.click(screen.getByRole('button',{name:'旋转 90°'}));
    await user.click(screen.getByRole('button',{name:'水平镜像'}));
    await user.click(screen.getAllByLabelText(/房间槽位/)[0]);
  });

  it('shows an invalid fit error and keeps cash and save unchanged', async () => {
    const user=userEvent.setup();
    const port=await floorPort();
    const before=await port.load('floor-save');
    render(<GameProvider savePort={port} saveId="floor-save"><FloorPlanningPage /></GameProvider>);
    await screen.findByRole('heading', { name:'高层酒店楼层规划' });

    await user.click(screen.getByLabelText('房间槽位 north-east'));

    expect(await screen.findByRole('alert')).toHaveTextContent('客房尺寸 8×12 超出槽位');
    expect(screen.getByText(`现金 ¥${before!.cashCents/100} · 已建 0/4 · 总建造成本 ¥0`)).toBeInTheDocument();
    expect(await port.load('floor-save')).toEqual(before);
  });
});
