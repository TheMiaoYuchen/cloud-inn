import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createGameCommands } from '../application/gameCommands';
import type { SavePort } from '../application/ports/SavePort';
import type { VisualProvider } from '../application/ports/VisualProvider';
import { PlaceholderVisualProvider } from '../infrastructure/visual/PlaceholderVisualProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type Cell, type GameState } from '../domain/game/state';

type Commands = ReturnType<typeof createGameCommands>;
type Ctx = { state: GameState | null; loading: boolean; commandPending: boolean; visualPending: boolean; error: string | null; commands: { [K in keyof Commands]: (...args: any[]) => Promise<boolean> }; visualProvider: VisualProvider };
export type RoomDraft = { name: string; cells: Cell[]; activeZone: 'bedroom'|'bathroom'; tool: 'paint'|'erase'|'rectangle'; visualPending: boolean };
const GameContext = createContext<(Ctx & { draft: RoomDraft; setDraftName:(v:string)=>void; setDraftCells:(v:Cell[])=>void; setActiveZone:(zone:RoomDraft['activeZone'])=>void; setTool:(tool:RoomDraft['tool'])=>void; applyDraftCell:(x:number,y:number)=>void; applyDraftRectangle:(x1:number,y1:number,x2:number,y2:number)=>void; clearDraft:()=>void }) | null>(null);
type InitResult = { state: GameState; port: SavePort; warning: string | null };
const initializations = new WeakMap<SavePort, Map<string, Promise<InitResult>>>();

function initialize(port: SavePort, saveId: string, allowMemoryFallback: boolean) {
  let bySave = initializations.get(port); if (!bySave) { bySave = new Map(); initializations.set(port, bySave); }
  const key = `${saveId}:${allowMemoryFallback}`;
  let task = bySave.get(key); if (!task) { task = (async () => { try { let state = await port.load(saveId as any); if (!state) { const fresh = createNewGame(saveId as any); state = { ...fresh, revision: 1 }; await port.commit(0, state); } return { state, port, warning: null }; } catch (e) { if (!allowMemoryFallback) throw e; const fallback = new InMemorySavePort(); const fresh = { ...createNewGame(saveId as any), revision: 1 }; await fallback.commit(0, fresh); return { state: fresh, port: fallback, warning: e instanceof Error ? e.message : '加载存档失败' }; } })(); bySave.set(key, task); }
  return task;
}

export function GameProvider({ children, savePort: port, saveId = 'save-1', visualProvider, allowMemoryFallback = false }: { children: React.ReactNode; savePort: SavePort; saveId?: string; visualProvider?: VisualProvider; allowMemoryFallback?: boolean }) {
  const [state, setState] = useState<GameState | null>(null);
  const [draft, setDraft] = useState<RoomDraft>({name:'',cells:[],activeZone:'bedroom',tool:'paint',visualPending:false});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePort, setActivePort] = useState<SavePort>(port);
  const [commandPending, setCommandPending] = useState(false); const [visualPending, setVisualPending] = useState(false); const stateRef = useRef(state); stateRef.current = state; const queue = useRef<Promise<unknown>>(Promise.resolve()); const pendingCount = useRef(0);
  useEffect(() => { let alive = true; setLoading(true); setState(null); stateRef.current=null; setActivePort(port); initialize(port, saveId, allowMemoryFallback).then(result => { if (alive) { setState(result.state); stateRef.current=result.state; setDraft(result.state.roomBlueprint ? { name: result.state.roomBlueprint.name, cells: structuredClone(result.state.roomBlueprint.cells), activeZone: 'bedroom', tool: 'paint', visualPending: false } : {name:'',cells:[],activeZone:'bedroom',tool:'paint',visualPending:false}); setActivePort(result.port); setError(result.warning); setLoading(false); } }, e => { if (alive) { setState(null); stateRef.current=null; setError(e instanceof Error?e.message:'加载存档失败'); setLoading(false); } }); return () => { alive = false; }; }, [port, saveId, allowMemoryFallback]);
  useEffect(() => { if (!state || loading) return; const dirty = draft.name !== (state.roomBlueprint?.name ?? '') || JSON.stringify(draft.cells) !== JSON.stringify(state.roomBlueprint?.cells ?? []); if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '你有未保存的房型修改'; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [state, loading, draft.name, draft.cells]);
  const commands = useMemo(() => { const names = ['saveRoomSeries','syncRoomSeries','chooseCorridorTemplate','placeRoomVariant','saveRoomBlueprint','placeRoom','setRate','requestVisual','requestDesignVisuals','openHotel','advanceDay'] as const; return Object.fromEntries(names.map(name => [name, (...args:any[]) => { pendingCount.current+=1; setCommandPending(true); if (name === 'requestVisual' || name === 'requestDesignVisuals') setVisualPending(true); const run = queue.current.then(async()=>{ const current=stateRef.current; if(!current)return false; try { const next=await (createGameCommands(activePort)[name] as any)(current,...args); stateRef.current=next; setState(next); setError(null); return true; } catch(e){setError(e instanceof Error?e.message:'操作失败'); return false} }); queue.current=run.finally(()=>{pendingCount.current-=1;if(name==='requestVisual' || name === 'requestDesignVisuals')setVisualPending(false);if(pendingCount.current===0)setCommandPending(false)}); return run; }])) as Ctx['commands']; }, [activePort]);
  const applyDraftCell=(x:number,y:number)=>setDraft(d=>{if(d.tool==='erase') return {...d,cells:d.cells.filter(c=>!(c.x===x&&c.y===y))}; return {...d,cells:[...d.cells.filter(c=>!(c.x===x&&c.y===y)),{x,y,zone:d.activeZone}]};});
  const applyDraftRectangle=(x1:number,y1:number,x2:number,y2:number)=>{const cells:Cell[]=[]; for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++)cells.push({x,y,zone:draft.activeZone}); setDraft(d=>({...d,cells:[...d.cells.filter(c=>!cells.some(n=>n.x===c.x&&n.y===c.y)),...cells]}));};
  return <GameContext.Provider value={{ state, loading, commandPending, visualPending, error, commands, draft, setDraftName:(name)=>setDraft(d=>({...d,name})), setDraftCells:(cells)=>setDraft(d=>({...d,cells})), setActiveZone:(activeZone)=>setDraft(d=>({...d,activeZone})), setTool:(tool)=>setDraft(d=>({...d,tool})), applyDraftCell, applyDraftRectangle, clearDraft:()=>setDraft(d=>({...d,cells:[]})), visualProvider: visualProvider ?? new PlaceholderVisualProvider() }}>{children}</GameContext.Provider>;
}
export function useGame() { const c = useContext(GameContext); if (!c) throw new Error('GameProvider missing'); return c; }
export type { Cell };
