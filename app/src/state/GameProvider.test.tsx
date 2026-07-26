import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GameProvider } from './GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { RoomDesignPage } from '../pages/RoomDesignPage';

describe('GameProvider flow', () => {
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
});
