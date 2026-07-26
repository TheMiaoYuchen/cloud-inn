import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createGameCommands } from '../application/gameCommands';
import type { SavePort } from '../application/ports/SavePort';
import type { VisualProvider } from '../application/ports/VisualProvider';
import { TauriSavePort } from '../infrastructure/tauri/TauriSavePort';
import { PlaceholderVisualProvider } from '../infrastructure/visual/PlaceholderVisualProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type Cell, type GameState } from '../domain/game/state';

type Commands = ReturnType<typeof createGameCommands>;
type Ctx = { state: GameState | null; loading: boolean; commandPending: boolean; error: string | null; commands: { [K in keyof Commands]: (...args: any[]) => Promise<void> }; visualProvider: VisualProvider };
export type RoomDraft = { name: string; cells: Cell[]; activeZone: 'bedroom'|'bathroom'; tool: 'paint'|'erase'|'rectangle'; visualPending: boolean };
const GameContext = createContext<(Ctx & { draft: RoomDraft; setDraftName:(v:string)=>void; setDraftCells:(v:Cell[])=>void; applyDraftCell:(x:number,y:number)=>void; applyDraftRectangle:(x1:number,y1:number,x2:number,y2:number)=>void; clearDraft:()=>void }) | null>(null);
type InitResult = { state: GameState; port: SavePort; warning: string | null };
const initializations = new WeakMap<SavePort, Map<string, Promise<InitResult>>>();

function initialize(port: SavePort, saveId: string) {
  let bySave = initializations.get(port); if (!bySave) { bySave = new Map(); initializations.set(port, bySave); }
  let task = bySave.get(saveId); if (!task) { task = (async () => { try { let state = await port.load(saveId as any); if (!state) { const fresh = createNewGame(saveId as any); state = { ...fresh, revision: 1 }; await port.commit(0, state); } return { state, port, warning: null }; } catch (e) { const fallback = new InMemorySavePort(); const fresh = { ...createNewGame(saveId as any), revision: 1 }; await fallback.commit(0, fresh); return { state: fresh, port: fallback, warning: e instanceof Error ? e.message : '加载存档失败' }; } })(); bySave.set(saveId, task); }
  return task;
}

export function GameProvider({ children, savePort, saveId = 'save-1', visualProvider }: { children: React.ReactNode; savePort?: SavePort; saveId?: string; visualProvider?: VisualProvider }) {
  const port = useMemo(() => savePort ?? new TauriSavePort(), [savePort]);
  const [state, setState] = useState<GameState | null>(null);
  const [draft, setDraft] = useState<RoomDraft>({name:'',cells:[],activeZone:'bedroom',tool:'paint',visualPending:false});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePort, setActivePort] = useState<SavePort>(port);
  const [commandPending, setCommandPending] = useState(false); const stateRef = useRef(state); stateRef.current = state; const queue = useRef(Promise.resolve());
  useEffect(() => { let alive = true; setLoading(true); setActivePort(port); initialize(port, saveId).then(result => { if (alive) { setState(result.state); stateRef.current=result.state; setActivePort(result.port); setError(result.warning); setLoading(false); } }); return () => { alive = false; }; }, [port, saveId]);
  const commands = useMemo(() => { const names = ['saveRoomBlueprint','placeRoom','setRate','requestVisual','openHotel','advanceDay'] as const; return Object.fromEntries(names.map(name => [name, (...args:any[]) => { setCommandPending(true); const run = queue.current.then(async()=>{ const current=stateRef.current; if(!current)return; try { const next=await (createGameCommands(activePort)[name] as any)(current,...args); stateRef.current=next; setState(next); setError(null); } catch(e){setError(e instanceof Error?e.message:'操作失败')} }); queue.current=run.finally(()=>setCommandPending(false)); return run; }])) as Ctx['commands']; }, [activePort]);
  const applyDraftCell=(x:number,y:number)=>setDraft(d=>{const has=d.cells.some(c=>c.x===x&&c.y===y); if(d.tool==='erase') return {...d,cells:d.cells.filter(c=>!(c.x===x&&c.y===y))}; if(has)return d; return {...d,cells:[...d.cells,{x,y,zone:d.activeZone}]};});
  const applyDraftRectangle=(x1:number,y1:number,x2:number,y2:number)=>{const cells:Cell[]=[]; for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++)cells.push({x,y,zone:draft.activeZone}); setDraft(d=>({...d,cells:[...d.cells.filter(c=>!cells.some(n=>n.x===c.x&&n.y===c.y)),...cells]}));};
  return <GameContext.Provider value={{ state, loading, commandPending, error, commands, draft, setDraftName:(name)=>setDraft(d=>({...d,name})), setDraftCells:(cells)=>setDraft(d=>({...d,cells})), applyDraftCell, applyDraftRectangle, clearDraft:()=>setDraft(d=>({...d,cells:[]})), visualProvider: visualProvider ?? new PlaceholderVisualProvider() }}>{children}</GameContext.Provider>;
}
export function useGame() { const c = useContext(GameContext); if (!c) throw new Error('GameProvider missing'); return c; }
export type { Cell };
