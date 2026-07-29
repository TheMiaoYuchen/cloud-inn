import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createGameCommands } from '../application/gameCommands';
import { createBuildingCommands } from '../application/buildingCommands';
import type { SavePort } from '../application/ports/SavePort';
import type { VisualProvider } from '../application/ports/VisualProvider';
import { PlaceholderVisualProvider } from '../infrastructure/visual/PlaceholderVisualProvider';
import { InMemorySavePort } from '../infrastructure/memory/InMemorySavePort';
import { createNewGame, type Cell, type GameState } from '../domain/game/state';
import { projectHotelInventory, type HotelInventoryRoom } from '../domain/building/hotelInventory';
import { previewExpansion, type ExpansionPreview } from '../domain/building/towerHotel';
import type { FacilityState } from '../domain/facilities/facilityTypes';
import type { HotelFloor, ScaleFloorTemplate } from '../domain/building/buildingTypes';
import { OPERATIONS_DAY_INTERVAL_MS, useOperationsClock } from './useOperationsClock';

type Commands = ReturnType<typeof createGameCommands> & ReturnType<typeof createBuildingCommands>;
export type StartupNotice = { message: string; settledDays: number; checkpointMs: number | null };
export type RoomOperatingStatus = 'available' | 'occupied' | 'renovating';
export type FloorProjection = {
  floor: HotelFloor;
  template: ScaleFloorTemplate | null;
  rooms: HotelInventoryRoom[];
  facilities: FacilityState[];
  open: boolean;
  roomStatusByOfferId: ReadonlyMap<string, RoomOperatingStatus>;
  roomStatusTotals: Readonly<Record<RoomOperatingStatus, number>>;
};
export type BuildingProjection = {
  floors: FloorProjection[];
  floorById: ReadonlyMap<string, FloorProjection>;
  expansionOffers: ExpansionPreview[];
  expansionOfferByFloorNumber: ReadonlyMap<number, ExpansionPreview>;
};
type Ctx = { state: GameState | null; building: BuildingProjection | null; loading: boolean; commandPending: boolean; visualPending: boolean; error: string | null; startupNotice: StartupNotice | null; commands: { [K in keyof Commands]: (...args: any[]) => Promise<boolean> }; visualProvider: VisualProvider };
export type RoomDraft = { name: string; cells: Cell[]; activeZone: 'bedroom'|'bathroom'; tool: 'paint'|'erase'|'rectangle'; visualPending: boolean };
const GameContext = createContext<(Ctx & { draft: RoomDraft; setDraftName:(v:string)=>void; setDraftCells:(v:Cell[])=>void; setActiveZone:(zone:RoomDraft['activeZone'])=>void; setTool:(tool:RoomDraft['tool'])=>void; applyDraftCell:(x:number,y:number)=>void; applyDraftRectangle:(x1:number,y1:number,x2:number,y2:number)=>void; clearDraft:()=>void }) | null>(null);
type InitResult = { state: GameState; port: SavePort; warning: string | null; startupNotice: StartupNotice | null };

async function initialize(port: SavePort, saveId: string, allowMemoryFallback: boolean, nowMs: number, millisecondsPerGameDay: number): Promise<InitResult> {
  try {
    let state = await port.load(saveId as any);
    const loadedState = state ? structuredClone(state) : null;
    if (!state) {
      state = { ...createNewGame(saveId as any), revision: 1 };
      await port.commit(0, state);
    } else if (state.operations) {
      state = await createGameCommands(port).settleOffline(state, nowMs, millisecondsPerGameDay);
    }
    const startupNotice = state.operations ? {
      message: state.currentDay > (loadedState?.currentDay ?? state.currentDay)
        ? `本次离线补算 ${state.currentDay - (loadedState?.currentDay ?? state.currentDay)} 天`
        : loadedState?.operations?.lastOfflineCheckpointMs === null
          ? '无需补算，已建立检查点'
          : '无需补算，检查点已更新',
      settledDays: Math.max(0, state.currentDay - (loadedState?.currentDay ?? state.currentDay)),
      checkpointMs: state.operations.lastOfflineCheckpointMs,
    } : null;
    return { state, port, warning: null, startupNotice };
  } catch (error) {
    if (!allowMemoryFallback) throw error;
    const fallback = new InMemorySavePort();
    const fresh = { ...createNewGame(saveId as any), revision: 1 };
    await fallback.commit(0, fresh);
    return { state: fresh, port: fallback, warning: error instanceof Error ? error.message : '加载存档失败', startupNotice: null };
  }
}

export function GameProvider({ children, savePort: port, saveId = 'save-1', visualProvider, allowMemoryFallback = false, nowMs = Date.now, millisecondsPerGameDay = OPERATIONS_DAY_INTERVAL_MS[1] }: { children: React.ReactNode; savePort: SavePort; saveId?: string; visualProvider?: VisualProvider; allowMemoryFallback?: boolean; nowMs?: () => number; millisecondsPerGameDay?: number }) {
  const [state, setState] = useState<GameState | null>(null);
  const [draft, setDraft] = useState<RoomDraft>({name:'',cells:[],activeZone:'bedroom',tool:'paint',visualPending:false});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startupNotice, setStartupNotice] = useState<StartupNotice | null>(null);
  const [activePort, setActivePort] = useState<SavePort>(port);
  const [commandPending, setCommandPending] = useState(false); const [visualPending, setVisualPending] = useState(false); const stateRef = useRef(state); stateRef.current = state; const queue = useRef<Promise<unknown>>(Promise.resolve()); const pendingCount = useRef(0);
  const lifecycleRef = useRef({ port, saveId, allowMemoryFallback, millisecondsPerGameDay, generation: 0 });
  const lifecycle = lifecycleRef.current;
  if (lifecycle.port !== port || lifecycle.saveId !== saveId || lifecycle.allowMemoryFallback !== allowMemoryFallback || lifecycle.millisecondsPerGameDay !== millisecondsPerGameDay) {
    lifecycleRef.current = { port, saveId, allowMemoryFallback, millisecondsPerGameDay, generation: lifecycle.generation + 1 };
    queue.current = Promise.resolve();
    pendingCount.current = 0;
  }
  const initRef = useRef<{ generation: number; task: Promise<InitResult> } | null>(null);
  useEffect(() => {
    let alive = true;
    const generation = lifecycleRef.current.generation;
    setLoading(true); setState(null); stateRef.current = null; setActivePort(port); setError(null); setStartupNotice(null); setCommandPending(false); setVisualPending(false);
    if (!initRef.current || initRef.current.generation !== generation) {
      initRef.current = { generation, task: initialize(port, saveId, allowMemoryFallback, nowMs(), millisecondsPerGameDay) };
    }
    initRef.current.task.then(result => {
      if (!alive || lifecycleRef.current.generation !== generation) return;
      setState(result.state); stateRef.current = result.state; setStartupNotice(result.startupNotice);
      setDraft(result.state.roomBlueprint ? { name: result.state.roomBlueprint.name, cells: structuredClone(result.state.roomBlueprint.cells), activeZone: 'bedroom', tool: 'paint', visualPending: false } : {name:'',cells:[],activeZone:'bedroom',tool:'paint',visualPending:false});
      setActivePort(result.port); setError(result.warning); setLoading(false);
    }, failure => {
      if (!alive || lifecycleRef.current.generation !== generation) return;
      setState(null); stateRef.current = null; setError(failure instanceof Error ? failure.message : '加载存档失败'); setLoading(false);
    });
    return () => { alive = false; };
  }, [port, saveId, allowMemoryFallback, nowMs, millisecondsPerGameDay]);
  useEffect(() => { if (!state || loading) return; const dirty = draft.name !== (state.roomBlueprint?.name ?? '') || JSON.stringify(draft.cells) !== JSON.stringify(state.roomBlueprint?.cells ?? []); if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '你有未保存的房型修改'; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [state, loading, draft.name, draft.cells]);
  const commands = useMemo(() => { const names = ['takeLoan','repayLoan','setDifficulty','setTimeSpeed','checkpointOfflineTime','initializeOperations','configureDepartment','renovateRoomOffer','setRoomPricePolicy','setAutomaticPricing','saveRoomSeries','syncRoomSeries','chooseCorridorTemplate','placeRoomVariant','saveRoomBlueprint','placeRoom','setRate','requestVisual','requestDesignVisuals','openHotel','advanceDay','advanceOperationsDays','settleOffline','initializeContentScale','purchaseFloor','copyFloor','syncFloorTemplate'] as const; return Object.fromEntries(names.map(name => [name, (...args:any[]) => { const generation = lifecycleRef.current.generation; pendingCount.current+=1; setCommandPending(true); if (name === 'requestVisual' || name === 'requestDesignVisuals') setVisualPending(true); const run = queue.current.then(async()=>{ if (lifecycleRef.current.generation !== generation) return false; const current=stateRef.current; if(!current)return false; try { const commandArgs = name === 'advanceDay' && args.length === 0 ? [nowMs()] : args; const commandSet = { ...createGameCommands(activePort), ...createBuildingCommands(activePort) }; const next=await (commandSet[name] as any)(current,...commandArgs); if (lifecycleRef.current.generation !== generation) return false; stateRef.current=next; setState(next); setError(null); return true; } catch(e){if (lifecycleRef.current.generation === generation) setError(e instanceof Error?e.message:'操作失败'); return false} }); queue.current=run.finally(()=>{if (lifecycleRef.current.generation !== generation) return; pendingCount.current-=1;if(name==='requestVisual' || name === 'requestDesignVisuals')setVisualPending(false);if(pendingCount.current===0)setCommandPending(false)}); return run; }])) as Ctx['commands']; }, [activePort, nowMs]);
  const building = useMemo<BuildingProjection | null>(() => {
    if (!state?.phase4) return null;
    const inventory = projectHotelInventory(state);
    const roomsByFloor = new Map<string, HotelInventoryRoom[]>();
    for (const room of inventory.rooms) {
      const rooms = roomsByFloor.get(room.floorId) ?? [];
      rooms.push(room);
      roomsByFloor.set(room.floorId, rooms);
    }
    const publicSpaceById = new Map(Object.values(state.phase4.publicSpaces).map(space => [space.id, space]));
    const facilitiesBySpaceId = new Map(inventory.facilities.map(facility => [facility.publicSpaceInstanceId, facility]));
    const reports = state.operations?.dailyReports ?? [];
    const latestReport = reports[reports.length - 1];
    const occupiedOfferIds = new Set(latestReport?.bookings?.map(booking => booking.offerId) ?? []);
    const occupiedRoomIds = new Set(latestReport?.bookings?.map(booking => booking.roomId) ?? []);
    const renovatingOfferIds = new Set(Object.values(state.operations?.offerUpgrades ?? {})
      .filter(upgrade => (upgrade.remainingClosureDays ?? 0) > 0)
      .map(upgrade => upgrade.roomOfferId));
    const floors = [...state.phase4.floors]
      .sort((left, right) => right.floorNumber - left.floorNumber || left.id.localeCompare(right.id))
      .map((floor): FloorProjection => {
        const rooms = roomsByFloor.get(floor.id) ?? [];
        const roomStatusByOfferId = new Map<string, RoomOperatingStatus>();
        const roomStatusTotals: Record<RoomOperatingStatus, number> = { available: 0, occupied: 0, renovating: 0 };
        for (const room of rooms) {
          const status: RoomOperatingStatus = renovatingOfferIds.has(room.id)
            ? 'renovating'
            : occupiedOfferIds.has(room.id) || occupiedRoomIds.has(room.sourceRoomId)
              ? 'occupied'
              : 'available';
          roomStatusByOfferId.set(room.id, status);
          roomStatusTotals[status] += 1;
        }
        return {
          floor,
          template: state.phase4!.floorTemplates[`template-snapshot:${floor.id}`] ?? state.phase4!.floorTemplates[floor.templateId] ?? null,
          rooms,
          facilities: floor.publicSpaceInstanceIds.flatMap(id => {
            const space = publicSpaceById.get(id);
            const facility = space ? facilitiesBySpaceId.get(space.id) : undefined;
            return facility ? [facility] : [];
          }),
          open: state.phase === 'open' && floor.purchased,
          roomStatusByOfferId,
          roomStatusTotals,
        };
      });
    const expansionOffers = [...state.phase4.building.availableExpansionFloorNumbers]
      .sort((left, right) => left - right)
      .map(floorNumber => previewExpansion(state, floorNumber));
    return {
      floors,
      floorById: new Map(floors.map(floor => [floor.floor.id, floor])),
      expansionOffers,
      expansionOfferByFloorNumber: new Map(expansionOffers.map(offer => [offer.floorNumber, offer])),
    };
  }, [state]);
  const operationsClockActive = state?.phase === 'open' && (state.currentDay ?? 30) < 30;
  useOperationsClock({ speed: operationsClockActive ? state?.operations?.timeSpeed ?? 0 : 0, advance: (tickNowMs) => commands.advanceDay(tickNowMs), nowMs, millisecondsPerGameDay });
  useEffect(() => { const checkpoint = () => { if (document.visibilityState === 'hidden' && stateRef.current?.operations) void commands.checkpointOfflineTime(nowMs()); }; document.addEventListener('visibilitychange', checkpoint); return () => document.removeEventListener('visibilitychange', checkpoint); }, [commands, nowMs]);
  const applyDraftCell=(x:number,y:number)=>setDraft(d=>{if(d.tool==='erase') return {...d,cells:d.cells.filter(c=>!(c.x===x&&c.y===y))}; return {...d,cells:[...d.cells.filter(c=>!(c.x===x&&c.y===y)),{x,y,zone:d.activeZone}]};});
  const applyDraftRectangle=(x1:number,y1:number,x2:number,y2:number)=>{const cells:Cell[]=[]; for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++)cells.push({x,y,zone:draft.activeZone}); setDraft(d=>({...d,cells:[...d.cells.filter(c=>!cells.some(n=>n.x===c.x&&n.y===c.y)),...cells]}));};
  return <GameContext.Provider value={{ state, building, loading, commandPending, visualPending, error, startupNotice, commands, draft, setDraftName:(name)=>setDraft(d=>({...d,name})), setDraftCells:(cells)=>setDraft(d=>({...d,cells})), setActiveZone:(activeZone)=>setDraft(d=>({...d,activeZone})), setTool:(tool)=>setDraft(d=>({...d,tool})), applyDraftCell, applyDraftRectangle, clearDraft:()=>setDraft(d=>({...d,cells:[]})), visualProvider: visualProvider ?? new PlaceholderVisualProvider() }}>{children}</GameContext.Provider>;
}
export function useGame() { const c = useContext(GameContext); if (!c) throw new Error('GameProvider missing'); return c; }
export type { Cell };
