import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { RoomDesignPage } from './RoomDesignPage';
import { CONTEMPORARY_ORIENTAL } from '../domain/design/stylePresets';
import { createRoomMaster, createRoomVariants } from '../domain/design/roomSeries';
import { createNewGame, type GameState } from '../domain/game/state';
import { createRectangle } from '../domain/room/grid';
import type { SavePort } from '../application/ports/SavePort';

class ExistingDesignPort implements SavePort {
  constructor(private state: GameState) {}
  async load() { return structuredClone(this.state); }
  async commit(_expectedRevision: number, next: GameState) { this.state = structuredClone(next); }
}

describe('phase two room editor', () => {
  it('renders the approved three-column editor and variant filmstrip', async () => {
    render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage /></GameProvider>);
    expect(await screen.findByRole('heading', { name: '设计你的第一间客房' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '房型工具' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '房型画布' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '房型属性' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '客房变体' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '当代东方静奢' })).toBeInTheDocument();
  });

  it('selects a style preset and saves a master series', async () => {
    const user = userEvent.setup();
    render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage /></GameProvider>);
    await screen.findByRole('button', { name: '云岫商务房' });
    await user.click(screen.getByRole('button', { name: '都市暖木行政' }));
    expect(screen.getByText('已选风格：都市暖木行政')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '云岫商务房' }));
    await user.click(screen.getByRole('button', { name: '保存客房系列' }));
    expect(await screen.findByText('母版与 3 个房型变体已保存')).toBeInTheDocument();
  });

  it('edits boundary openings with side selection and includes them in undo/redo', async()=>{
    const user=userEvent.setup(); render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage/></GameProvider>);
    await screen.findByRole('button',{name:'墙体'});
    for(const name of ['选择','墙体','门','窗']) expect(screen.getByRole('button',{name})).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '云岫商务房' }));
    await user.click(screen.getByRole('button', { name: '墙体' }));
    await user.click(screen.getByRole('button', { name: '东侧' }));
    const cell=screen.getByRole('button',{name:'格子 7,0'}); await user.click(cell);
    expect(cell).toHaveAttribute('data-opening','wall');
    expect(screen.getByRole('button',{name:'撤销'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'撤销'}));
    expect(cell).not.toHaveAttribute('data-opening');
    expect(screen.getByRole('button',{name:'重做'})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:'重做'}));
    expect(cell).toHaveAttribute('data-opening','wall');
  });

  it('rejects an opening that is not on the selected room boundary', async()=>{
    const user=userEvent.setup(); render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage/></GameProvider>);
    await user.click(await screen.findByRole('button', { name: '云岫商务房' }));
    await user.click(screen.getByRole('button', { name: '门' }));
    await user.click(screen.getByRole('button', { name: '东侧' }));
    await user.click(screen.getByRole('button',{name:'格子 1,1'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('开口必须位于房间边界');
    expect(screen.getByRole('button',{name:'格子 1,1'})).not.toHaveAttribute('data-opening');
  });

  it('does not show a success notice after an invalid save', async()=>{
    const user=userEvent.setup(); render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage/></GameProvider>);
    await user.click(await screen.findByRole('button',{name:'保存客房系列'}));
    expect(await screen.findByText('客房母版名称不能为空')).toBeInTheDocument();
    expect(screen.queryByText('母版与 3 个房型变体已保存')).not.toBeInTheDocument();
  });

  it('restores the authoritative room draft and openings from a loaded master', async()=>{
    const base=createNewGame('loaded-editor');
    const cells=[...createRectangle(0,0,4,3,'bedroom'),...createRectangle(0,3,4,1,'bathroom')];
    const master=createRoomMaster({id:'loaded-master',name:'已保存母版',cells,columns:8,rows:12,gene:CONTEMPORARY_ORIENTAL.gene,openings:{walls:[],doors:[{x:0,y:1,side:'west'}],windows:[]}});
    const state:GameState={...base,revision:1,phase2:{hotelGene:CONTEMPORARY_ORIENTAL.gene,roomMaster:master,roomVariants:createRoomVariants(master),corridorTemplate:null}};

    render(<GameProvider savePort={new ExistingDesignPort(state)} saveId={state.saveId}><RoomDesignPage/></GameProvider>);

    expect(await screen.findByRole('button',{name:'格子 0,1'})).toHaveAttribute('data-opening','door');
  });

  it('selects a rectangular region without changing room history and clears it on tool change', async()=>{
    const user=userEvent.setup();
    render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage/></GameProvider>);
    await screen.findByRole('button',{name:'选择'});
    expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled();

    await user.click(screen.getByRole('button',{name:'选择'}));
    await user.click(screen.getByRole('button',{name:'格子 1,2'}));
    expect(screen.getByText('请选择区域的第二个角点')).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'格子 3,4'}));

    expect(screen.getByText('已选择 3×3，共 9 格')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'格子 1,2'})).toHaveAttribute('data-selected','true');
    expect(screen.getByRole('button',{name:'格子 3,4'})).toHaveAttribute('data-selected','true');
    expect(screen.getByRole('button',{name:'撤销'})).toBeDisabled();

    await user.click(screen.getByRole('button',{name:'画笔'}));
    expect(screen.queryByText('已选择 3×3，共 9 格')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'格子 1,2'})).not.toHaveAttribute('data-selected');
  });
});
