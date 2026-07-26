import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createGameCommands } from '../application/gameCommands';
import type { SavePort } from '../application/ports/SavePort';
import type { VisualProvider } from '../application/ports/VisualProvider';
import { TauriSavePort } from '../infrastructure/tauri/TauriSavePort';
import { PlaceholderVisualProvider } from '../infrastructure/visual/PlaceholderVisualProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type Cell, type GameState } from '../domain/game/state';

type Commands = ReturnType<typeof createGameCommands>;
type Ctx = { state: GameState | null; loading: boolean; error: string | null; commands: { [K in keyof Commands]: (...args: any[]) => Promise<void> }; visualProvider: VisualProvider };
const GameContext = createContext<Ctx | null>(null);

export function GameProvider({ children, savePort, saveId = 'save-1', visualProvider }: { children: React.ReactNode; savePort?: SavePort; saveId?: string; visualProvider?: VisualProvider }) {
  const port = useMemo(() => savePort ?? new TauriSavePort(), [savePort]);
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePort, setActivePort] = useState<SavePort>(port);
  useEffect(() => { let alive = true; (async () => { try { let loaded = await port.load(saveId as any); if (!loaded) { const fresh = createNewGame(saveId as any); await port.commit(0, { ...fresh, revision: 1 }); loaded = { ...fresh, revision: 1 }; } if (alive) setState(loaded); } catch (e) { const mem = new InMemorySavePort(); const fresh = createNewGame(saveId as any); await mem.commit(0, { ...fresh, revision: 1 }); if (alive) { setActivePort(mem); setError(e instanceof Error ? e.message : '加载存档失败'); setState({ ...fresh, revision: 1 }); } } finally { if (alive) setLoading(false); } })(); return () => { alive = false; }; }, [port, saveId]);
  const raw = useMemo(() => createGameCommands(activePort), [activePort]);
  const commands = useMemo(() => Object.fromEntries(Object.entries(raw).map(([k, fn]) => [k, async (...args: any[]) => { if (!state) return; try { const next = await (fn as any)(state, ...args); setState(next); setError(null); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } }])) as Ctx['commands'], [raw, state]);
  return <GameContext.Provider value={{ state, loading, error, commands, visualProvider: visualProvider ?? new PlaceholderVisualProvider() }}>{children}</GameContext.Provider>;
}
export function useGame() { const c = useContext(GameContext); if (!c) throw new Error('GameProvider missing'); return c; }
export type { Cell };
