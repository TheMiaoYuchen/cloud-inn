import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RoomDesignPage } from './RoomDesignPage';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';

describe('phase1 regressions', () => {
 it('uses domain floor slots', async()=>{ const p=new InMemorySavePort(); const u=userEvent.setup(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); await u.click(await screen.findByRole('button',{name:'云岫商务房'})); await u.click(screen.getByRole('button',{name:'保存并进入楼层'})); expect(await screen.findByText(/西北/)).toBeInTheDocument(); });
 it('renders valid 8x12 grid only', async()=>{ const p=new InMemorySavePort(); render(<GameProvider savePort={p}><RoomDesignPage/></GameProvider>); expect(await screen.findByRole('button',{name:'格子 7,11'})).toBeInTheDocument(); expect(screen.queryByRole('button',{name:'格子 8,11'})).not.toBeInTheDocument(); });
});
