import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RoomDesignPage } from './RoomDesignPage';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';

describe('phase1 regressions', () => {
 it('uses domain floor slots', async()=>{ const p=new InMemorySavePort(); const u=userEvent.setup(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); await u.click(await screen.findByRole('button',{name:'云岫商务房'})); await u.click(screen.getByRole('button',{name:'保存并进入楼层'})); expect(await screen.findByText(/西北/)).toBeInTheDocument(); });
 it('renders valid 8x12 grid only', async()=>{ const p=new InMemorySavePort(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); expect(await screen.findByRole('button',{name:'格子 7,11'})).toBeInTheDocument(); expect(screen.queryByRole('button',{name:'格子 8,11'})).not.toBeInTheDocument(); });
 it('paints zones, replaces them, and erases cells', async()=>{ const p=new InMemorySavePort(); const u=userEvent.setup(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); const cell=await screen.findByRole('button',{name:'格子 0,0'}); await u.click(cell); expect(cell).toHaveAttribute('data-zone','bedroom'); await u.click(screen.getByRole('button',{name:'bathroom'})); await u.click(cell); expect(cell).toHaveAttribute('data-zone','bathroom'); await u.click(screen.getByRole('button',{name:'erase'})); await u.click(cell); expect(cell).not.toHaveAttribute('data-zone'); });
 it('fills a rectangle after selecting two corners', async()=>{ const p=new InMemorySavePort(); const u=userEvent.setup(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); await screen.findByRole('button',{name:'格子 0,0'}); await u.click(screen.getByRole('button',{name:'rectangle'})); await u.click(screen.getByRole('button',{name:'格子 1,1'})); await u.click(screen.getByRole('button',{name:'格子 2,2'})); for(const name of ['格子 1,1','格子 2,1','格子 1,2','格子 2,2']) expect(screen.getByRole('button',{name})).toHaveAttribute('data-zone','bedroom'); });
});
