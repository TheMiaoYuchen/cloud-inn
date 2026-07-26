import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GameProvider } from '../state/GameProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { RoomDesignPage } from './RoomDesignPage';

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
});
