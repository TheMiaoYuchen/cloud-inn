# Cloud Inn Phase 1 Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a deterministic prototype where the player designs one 24㎡ room type, builds four rooms on one fixed floor, opens at a chosen rate, settles two days, attaches one local visual, and restores the complete game from SQLite.

**Architecture:** Pure TypeScript owns grids, evaluation, placement, settlement, commands, and state. React/PixiJS only render state and send commands. A typed `SavePort` lets tests use memory while the packaged app uses a Tauri command backed by a versioned SQLite database; a separate `VisualProvider` proves that visual success or failure cannot affect hotel economics.

**Tech Stack:** Existing Phase 0 stack plus Rust `rusqlite`/`serde_json`, Vitest, Testing Library, Playwright, Tauri 2.

---

## Fixed Prototype Fixture

All currency values are integer cents and all percentages are integer basis points (`10_000 = 100%`). Keep these values in `prototypeConfig.ts`, never inline them elsewhere.

- Starting cash: `100_000_000` cents (¥1,000,000).
- Room: `8 × 12 = 96` cells; each cell is `0.25㎡`; total `24㎡`.
- Bedroom: rows `0..7`; bathroom: rows `8..11`.
- Build cost: `2_000_000 + 400_000 × area㎡ = 11_600_000` cents (¥116,000) per room.
- Suggested daily rate: `32_000 + 2_000 × area㎡ = 80_000` cents (¥800).
- Floor: four predefined room slots beside an immutable corridor/core.
- Business demand: three bookings per day before price conversion.
- Daily operating cost: `8_000 × available rooms + 15_000 × sold rooms` cents.
- At ¥800 with four rooms: three sold, `240_000` cents revenue, `77_000` cents cost, `163_000` cents net income.
- At twice the suggested price: price conversion is zero and no rooms sell.

## File Map

- Create: `app/src/domain/primitives.ts` - branded identifiers, money, basis points, revisions.
- Create: `app/src/domain/config/prototypeConfig.ts` - all prototype content and balance data.
- Create: `app/src/domain/room/grid.ts` - zoning commands, normalization, area, continuity.
- Create: `app/src/domain/room/evaluateRoom.ts` - build cost, suggested rate, business fit.
- Create: `app/src/domain/floor/planFloor.ts` - fixed slots, placement validation, room instances.
- Create: `app/src/domain/simulation/settleDay.ts` - deterministic demand and ledger.
- Create: `app/src/domain/game/state.ts` - authoritative game state and new-game factory.
- Create: `app/src/application/gameCommands.ts` - the only mutation entry point.
- Create: `app/src/application/ports/SavePort.ts` - persistence contract.
- Create: `app/src/application/ports/VisualProvider.ts` - visual contract.
- Create: `app/src/infrastructure/memory/InMemorySavePort.ts` - tests/browser development.
- Create: `app/src/infrastructure/visual/PlaceholderVisualProvider.ts` - offline visual.
- Create: `app/src/infrastructure/tauri/TauriSavePort.ts` - typed Tauri bridge.
- Create: `app/src/state/GameProvider.tsx` - React application state and dependency injection.
- Create: `app/src/state/roomDraft.ts` - unsaved editor draft and drawing commands.
- Create: `app/src/pages/RoomDesignPage.tsx` - rectangle/paint design step.
- Create: `app/src/pages/FloorPlanningPage.tsx` - fixed-slot placement step.
- Create: `app/src/pages/OperationsPage.tsx` - rate, opening, settlement, reasons.
- Create: `app/src-tauri/migrations/001_initial.sql` - normalized save schema.
- Create: `app/src-tauri/src/persistence.rs` - migration and transactional snapshot persistence.
- Modify: `app/src-tauri/src/lib.rs` - register typed commands.
- Create: `app/e2e/core-loop.spec.ts` - browser closed-loop flow.
- Create: `docs/testing/phase-1-desktop-smoke.md` - SQLite close/reopen verification.

### Task 1: Define Domain Primitives, Configuration, and New Game

**Files:**
- Create: `app/src/domain/primitives.ts`
- Create: `app/src/domain/config/prototypeConfig.ts`
- Create: `app/src/domain/game/state.ts`
- Create: `app/src/domain/game/state.test.ts`

- [ ] **Step 1: Write the failing new-game test**

```ts
// app/src/domain/game/state.test.ts
import { describe, expect, it } from "vitest";
import { createNewGame } from "./state";

describe("createNewGame", () => {
  it("creates the fixed planning-state prototype", () => {
    const game = createNewGame("save-1");
    expect(game.phase).toBe("design");
    expect(game.currentDay).toBe(0);
    expect(game.cashCents).toBe(100_000_000);
    expect(game.roomBlueprint).toBeNull();
    expect(game.floor.rooms).toEqual([]);
    expect(game.rateCents).toBe(80_000);
    expect(game.latestReport).toBeNull();
    expect(game.revision).toBe(0);
  });
});
```

- [ ] **Step 2: Verify the domain modules are missing**

Run: `cd app && npm test -- src/domain/game/state.test.ts`

Expected: FAIL with missing module `./state`.

- [ ] **Step 3: Add primitives and prototype configuration**

```ts
// app/src/domain/primitives.ts
export type SaveId = string;
export type RoomBlueprintId = string;
export type RoomInstanceId = string;
export type MoneyCents = number;
export type BasisPoints = number;
export type Revision = number;
export type GameDay = number;

export function assertSafeMoney(value: number): MoneyCents {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("金额必须是非负整数分");
  return value;
}
```

```ts
// app/src/domain/config/prototypeConfig.ts
export const prototypeConfig = {
  rulesetVersion: "prototype-v1",
  cellAreaSquareMeters: 0.25,
  roomColumns: 8,
  roomRows: 12,
  startingCashCents: 100_000_000,
  buildBaseCents: 2_000_000,
  buildPerSquareMeterCents: 400_000,
  suggestedRateBaseCents: 32_000,
  suggestedRatePerSquareMeterCents: 2_000,
  businessDemandPerDay: 3,
  availableRoomCostCents: 8_000,
  occupiedRoomCostCents: 15_000,
  floorSlots: [
    { id: "slot-nw", x: 0, y: 0 },
    { id: "slot-ne", x: 8, y: 0 },
    { id: "slot-sw", x: 0, y: 14 },
    { id: "slot-se", x: 8, y: 14 },
  ],
} as const;
```

- [ ] **Step 4: Implement the authoritative state shape and factory**

```ts
// app/src/domain/game/state.ts
import { prototypeConfig } from "../config/prototypeConfig";
import type { BasisPoints, GameDay, MoneyCents, Revision, RoomBlueprintId, RoomInstanceId, SaveId } from "../primitives";

export type ZoneKind = "bedroom" | "bathroom";
export interface Cell { x: number; y: number; zone: ZoneKind }
export interface RoomMetrics {
  areaSquareMeters: number;
  buildCostCents: MoneyCents;
  suggestedRateCents: MoneyCents;
  businessFitBps: BasisPoints;
}
export interface RoomBlueprint {
  id: RoomBlueprintId;
  name: string;
  columns: number;
  rows: number;
  cells: Cell[];
  metrics: RoomMetrics;
  visual: VisualState;
}
export interface RoomInstance {
  id: RoomInstanceId;
  slotId: string;
  roomBlueprintId: RoomBlueprintId;
  committedBuildCostCents: MoneyCents;
}
export interface DailyReport {
  day: GameDay;
  availableRooms: number;
  soldRooms: number;
  occupancyBps: BasisPoints;
  rateCents: MoneyCents;
  revenueCents: MoneyCents;
  operatingCostCents: MoneyCents;
  netIncomeCents: number;
  endingCashCents: MoneyCents;
  reasons: string[];
}
export type VisualState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; assetPath: string }
  | { status: "error"; message: string };
export interface GameState {
  schemaVersion: 1;
  rulesetVersion: string;
  saveId: SaveId;
  revision: Revision;
  phase: "design" | "floor" | "ready" | "open";
  currentDay: GameDay;
  cashCents: MoneyCents;
  rateCents: MoneyCents;
  roomBlueprint: RoomBlueprint | null;
  floor: { id: "prototype-floor"; rooms: RoomInstance[] };
  reports: DailyReport[];
  latestReport: DailyReport | null;
}

export function createNewGame(saveId: SaveId): GameState {
  return {
    schemaVersion: 1,
    rulesetVersion: prototypeConfig.rulesetVersion,
    saveId,
    revision: 0,
    phase: "design",
    currentDay: 0,
    cashCents: prototypeConfig.startingCashCents,
    rateCents: 80_000,
    roomBlueprint: null,
    floor: { id: "prototype-floor", rooms: [] },
    reports: [],
    latestReport: null,
  };
}
```

- [ ] **Step 5: Run domain tests and typecheck**

Run: `cd app && npm test -- src/domain/game/state.test.ts && npm run typecheck`

Expected: test and typecheck pass.

- [ ] **Step 6: Commit the domain contract**

```bash
git add app/src/domain
git commit -m "feat: define prototype game state"
```

### Task 2: Implement the 0.5-Meter Zoned Room Grid

**Files:**
- Create: `app/src/domain/room/grid.ts`
- Create: `app/src/domain/room/grid.test.ts`

- [ ] **Step 1: Write failing grid behavior tests**

```ts
// app/src/domain/room/grid.test.ts
import { describe, expect, it } from "vitest";
import { addCell, createRectangle, eraseCell, validateRoomCells } from "./grid";

describe("room grid", () => {
  it("creates the 24 square meter bedroom and bathroom fixture", () => {
    const bedroom = createRectangle(0, 0, 8, 8, "bedroom");
    const bathroom = createRectangle(0, 8, 8, 4, "bathroom");
    const result = validateRoomCells([...bedroom, ...bathroom], 8, 12);
    expect(result).toEqual({ ok: true, areaSquareMeters: 24 });
  });

  it("adds and erases a cell idempotently", () => {
    const once = addCell([], { x: 0, y: 0, zone: "bedroom" });
    const twice = addCell(once, { x: 0, y: 0, zone: "bedroom" });
    expect(twice).toHaveLength(1);
    expect(eraseCell(twice, 0, 0)).toEqual([]);
    expect(eraseCell([], 0, 0)).toEqual([]);
  });

  it("rejects disconnected and single-zone layouts", () => {
    expect(validateRoomCells([
      { x: 0, y: 0, zone: "bedroom" },
      { x: 7, y: 11, zone: "bathroom" },
    ], 8, 12)).toEqual({ ok: false, reason: "房间轮廓必须连续" });
    expect(validateRoomCells([{ x: 0, y: 0, zone: "bedroom" }], 8, 12))
      .toEqual({ ok: false, reason: "原型房型需要卧室和卫浴" });
  });
});
```

- [ ] **Step 2: Verify the grid module is missing**

Run: `cd app && npm test -- src/domain/room/grid.test.ts`

Expected: FAIL with missing module `./grid`.

- [ ] **Step 3: Implement normalized grid commands and validation**

```ts
// app/src/domain/room/grid.ts
import { prototypeConfig } from "../config/prototypeConfig";
import type { Cell, ZoneKind } from "../game/state";

const key = (cell: Pick<Cell, "x" | "y">) => `${cell.x}:${cell.y}`;
const sorted = (cells: Cell[]) => [...cells].sort((a, b) => a.y - b.y || a.x - b.x);

export function createRectangle(x: number, y: number, width: number, height: number, zone: ZoneKind): Cell[] {
  const cells: Cell[] = [];
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) cells.push({ x: column, y: row, zone });
  }
  return sorted(cells);
}

export function addCell(cells: Cell[], cell: Cell): Cell[] {
  const map = new Map(cells.map((current) => [key(current), current]));
  map.set(key(cell), cell);
  return sorted([...map.values()]);
}

export function eraseCell(cells: Cell[], x: number, y: number): Cell[] {
  return cells.filter((cell) => cell.x !== x || cell.y !== y);
}

export type RoomValidation = { ok: true; areaSquareMeters: number } | { ok: false; reason: string };

export function validateRoomCells(cells: Cell[], columns: number, rows: number): RoomValidation {
  if (cells.length === 0) return { ok: false, reason: "房间不能为空" };
  if (cells.some((cell) => cell.x < 0 || cell.y < 0 || cell.x >= columns || cell.y >= rows)) {
    return { ok: false, reason: "房间超出网格边界" };
  }
  const zones = new Set(cells.map((cell) => cell.zone));
  if (!zones.has("bedroom") || !zones.has("bathroom")) return { ok: false, reason: "原型房型需要卧室和卫浴" };
  const all = new Set(cells.map(key));
  const seen = new Set<string>();
  const queue = [cells[0]];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = key(current);
    if (seen.has(currentKey)) continue;
    seen.add(currentKey);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbor = `${current.x + dx}:${current.y + dy}`;
      if (all.has(neighbor) && !seen.has(neighbor)) queue.push({ x: current.x + dx, y: current.y + dy, zone: current.zone });
    }
  }
  if (seen.size !== all.size) return { ok: false, reason: "房间轮廓必须连续" };
  return { ok: true, areaSquareMeters: cells.length * prototypeConfig.cellAreaSquareMeters };
}
```

- [ ] **Step 4: Run grid tests**

Run: `cd app && npm test -- src/domain/room/grid.test.ts`

Expected: all grid tests pass.

- [ ] **Step 5: Commit the grid domain**

```bash
git add app/src/domain/room
git commit -m "feat: add zoned room grid rules"
```

### Task 3: Evaluate Room Cost, Rate, and Business Fit

**Files:**
- Create: `app/src/domain/room/evaluateRoom.ts`
- Create: `app/src/domain/room/evaluateRoom.test.ts`

- [ ] **Step 1: Write failing evaluation tests**

```ts
// app/src/domain/room/evaluateRoom.test.ts
import { describe, expect, it } from "vitest";
import { createRectangle } from "./grid";
import { evaluateRoom } from "./evaluateRoom";

const fixture = [
  ...createRectangle(0, 0, 8, 8, "bedroom"),
  ...createRectangle(0, 8, 8, 4, "bathroom"),
];

describe("evaluateRoom", () => {
  it("evaluates the fixed 24 square meter room", () => {
    expect(evaluateRoom(fixture, 8, 12)).toEqual({
      areaSquareMeters: 24,
      buildCostCents: 11_600_000,
      suggestedRateCents: 80_000,
      businessFitBps: 8_500,
    });
  });

  it("changes cost and fit when area changes", () => {
    const smaller = fixture.slice(0, 80);
    const result = evaluateRoom(smaller, 8, 12);
    expect(result.buildCostCents).toBeLessThan(11_600_000);
    expect(result.businessFitBps).toBeLessThan(8_500);
  });
});
```

- [ ] **Step 2: Verify the evaluator is missing**

Run: `cd app && npm test -- src/domain/room/evaluateRoom.test.ts`

Expected: FAIL with missing module `./evaluateRoom`.

- [ ] **Step 3: Implement deterministic evaluation**

```ts
// app/src/domain/room/evaluateRoom.ts
import { prototypeConfig } from "../config/prototypeConfig";
import type { Cell, RoomMetrics } from "../game/state";
import { assertSafeMoney } from "../primitives";
import { validateRoomCells } from "./grid";

export function evaluateRoom(cells: Cell[], columns: number, rows: number): RoomMetrics {
  const validation = validateRoomCells(cells, columns, rows);
  if (!validation.ok) throw new Error(validation.reason);
  const area = validation.areaSquareMeters;
  return {
    areaSquareMeters: area,
    buildCostCents: assertSafeMoney(prototypeConfig.buildBaseCents + prototypeConfig.buildPerSquareMeterCents * area),
    suggestedRateCents: assertSafeMoney(prototypeConfig.suggestedRateBaseCents + prototypeConfig.suggestedRatePerSquareMeterCents * area),
    businessFitBps: Math.max(0, Math.min(10_000, 8_500 - Math.abs(24 - area) * 250)),
  };
}
```

- [ ] **Step 4: Run evaluator and domain tests**

Run: `cd app && npm test -- src/domain/room`

Expected: all room tests pass.

- [ ] **Step 5: Commit room evaluation**

```bash
git add app/src/domain/room
git commit -m "feat: evaluate prototype room economics"
```

### Task 4: Place and Remove Rooms on the Fixed Floor

**Files:**
- Create: `app/src/domain/floor/planFloor.ts`
- Create: `app/src/domain/floor/planFloor.test.ts`

- [ ] **Step 1: Write failing placement tests**

```ts
// app/src/domain/floor/planFloor.test.ts
import { describe, expect, it } from "vitest";
import { prototypeConfig } from "../config/prototypeConfig";
import type { RoomBlueprint } from "../game/state";
import { placeRoom, removeRoom } from "./planFloor";

const blueprint: RoomBlueprint = {
  id: "room-type-1", name: "云岫商务房", columns: 8, rows: 12, cells: [],
  metrics: { areaSquareMeters: 24, buildCostCents: 11_600_000, suggestedRateCents: 80_000, businessFitBps: 8_500 },
  visual: { status: "idle" },
};

describe("floor planning", () => {
  it("places four rooms and rejects a duplicate slot", () => {
    let rooms = [];
    for (const slot of prototypeConfig.floorSlots) rooms = placeRoom(rooms, blueprint, slot.id).rooms;
    expect(rooms).toHaveLength(4);
    expect(() => placeRoom(rooms, blueprint, "slot-nw")).toThrow("这个位置已有客房");
  });

  it("refunds the committed build cost before opening", () => {
    const placed = placeRoom([], blueprint, "slot-nw").rooms;
    const result = removeRoom(placed, placed[0].id);
    expect(result.rooms).toEqual([]);
    expect(result.refundCents).toBe(11_600_000);
  });
});
```

- [ ] **Step 2: Verify the floor module is missing**

Run: `cd app && npm test -- src/domain/floor/planFloor.test.ts`

Expected: FAIL with missing module `./planFloor`.

- [ ] **Step 3: Implement fixed-slot placement**

```ts
// app/src/domain/floor/planFloor.ts
import { prototypeConfig } from "../config/prototypeConfig";
import type { RoomBlueprint, RoomInstance } from "../game/state";

export function placeRoom(rooms: RoomInstance[], blueprint: RoomBlueprint, slotId: string) {
  if (!prototypeConfig.floorSlots.some((slot) => slot.id === slotId)) throw new Error("这个位置不在可建区域内");
  if (rooms.some((room) => room.slotId === slotId)) throw new Error("这个位置已有客房");
  const instance: RoomInstance = {
    id: `room-${slotId}`,
    slotId,
    roomBlueprintId: blueprint.id,
    committedBuildCostCents: blueprint.metrics.buildCostCents,
  };
  return { rooms: [...rooms, instance], costCents: instance.committedBuildCostCents };
}

export function removeRoom(rooms: RoomInstance[], roomId: string) {
  const room = rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error("找不到要移除的客房");
  return { rooms: rooms.filter((candidate) => candidate.id !== roomId), refundCents: room.committedBuildCostCents };
}
```

- [ ] **Step 4: Run floor tests**

Run: `cd app && npm test -- src/domain/floor/planFloor.test.ts`

Expected: all floor tests pass.

- [ ] **Step 5: Commit the floor planner**

```bash
git add app/src/domain/floor
git commit -m "feat: add fixed-floor room placement"
```

### Task 5: Implement Deterministic Business Demand and Day Settlement

**Files:**
- Create: `app/src/domain/simulation/settleDay.ts`
- Create: `app/src/domain/simulation/settleDay.test.ts`

- [ ] **Step 1: Write failing settlement tests**

```ts
// app/src/domain/simulation/settleDay.test.ts
import { describe, expect, it } from "vitest";
import { settleDay } from "./settleDay";

describe("settleDay", () => {
  it("settles the approved four-room fixture at the suggested price", () => {
    expect(settleDay({ day: 1, cashCents: 53_600_000, availableRooms: 4, rateCents: 80_000, suggestedRateCents: 80_000, areaSquareMeters: 24 }))
      .toEqual({
        day: 1, availableRooms: 4, soldRooms: 3, occupancyBps: 7_500,
        rateCents: 80_000, revenueCents: 240_000, operatingCostCents: 77_000,
        netIncomeCents: 163_000, endingCashCents: 53_763_000,
        reasons: ["24㎡满足商务客的面积期望", "房价处于建议价，需求转化正常"],
      });
  });

  it("sells no rooms at twice the suggested price", () => {
    const report = settleDay({ day: 2, cashCents: 53_763_000, availableRooms: 4, rateCents: 160_000, suggestedRateCents: 80_000, areaSquareMeters: 24 });
    expect(report.soldRooms).toBe(0);
    expect(report.revenueCents).toBe(0);
    expect(report.operatingCostCents).toBe(32_000);
  });

  it("never sells above demand or inventory", () => {
    expect(settleDay({ day: 1, cashCents: 1_000_000, availableRooms: 2, rateCents: 80_000, suggestedRateCents: 80_000, areaSquareMeters: 24 }).soldRooms).toBe(2);
  });
});
```

- [ ] **Step 2: Verify settlement is missing**

Run: `cd app && npm test -- src/domain/simulation/settleDay.test.ts`

Expected: FAIL with missing module `./settleDay`.

- [ ] **Step 3: Implement deterministic settlement**

```ts
// app/src/domain/simulation/settleDay.ts
import { prototypeConfig } from "../config/prototypeConfig";
import type { DailyReport } from "../game/state";
import { assertSafeMoney } from "../primitives";

interface SettlementInput {
  day: number;
  cashCents: number;
  availableRooms: number;
  rateCents: number;
  suggestedRateCents: number;
  areaSquareMeters: number;
}

export function settleDay(input: SettlementInput): DailyReport {
  const priceRatio = input.rateCents / input.suggestedRateCents;
  const conversion = Math.max(0, Math.min(1, 2 - priceRatio));
  const convertedDemand = Math.floor(prototypeConfig.businessDemandPerDay * conversion);
  const soldRooms = Math.min(input.availableRooms, convertedDemand);
  const revenueCents = assertSafeMoney(soldRooms * input.rateCents);
  const operatingCostCents = assertSafeMoney(
    input.availableRooms * prototypeConfig.availableRoomCostCents + soldRooms * prototypeConfig.occupiedRoomCostCents,
  );
  const netIncomeCents = revenueCents - operatingCostCents;
  const endingCashCents = assertSafeMoney(input.cashCents + netIncomeCents);
  return {
    day: input.day,
    availableRooms: input.availableRooms,
    soldRooms,
    occupancyBps: input.availableRooms === 0 ? 0 : Math.floor((soldRooms * 10_000) / input.availableRooms),
    rateCents: input.rateCents,
    revenueCents,
    operatingCostCents,
    netIncomeCents,
    endingCashCents,
    reasons: [
      `${input.areaSquareMeters}㎡满足商务客的面积期望`,
      priceRatio === 1 ? "房价处于建议价，需求转化正常" : priceRatio >= 2 ? "房价达到建议价两倍，商务需求未转化" : "房价变化影响了需求转化",
    ],
  };
}
```

- [ ] **Step 4: Run simulation and full domain tests**

Run: `cd app && npm test -- src/domain`

Expected: all domain tests pass.

- [ ] **Step 5: Commit deterministic settlement**

```bash
git add app/src/domain/simulation
git commit -m "feat: settle deterministic hotel days"
```

### Task 6: Add Tested Application Commands and Memory Persistence

**Files:**
- Create: `app/src/application/ports/SavePort.ts`
- Create: `app/src/infrastructure/memory/InMemorySavePort.ts`
- Create: `app/src/application/gameCommands.ts`
- Create: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write the failing command-flow test**

```ts
// app/src/application/gameCommands.test.ts
import { describe, expect, it } from "vitest";
import { createNewGame } from "../domain/game/state";
import { createRectangle } from "../domain/room/grid";
import { createGameCommands } from "./gameCommands";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";

describe("game commands", () => {
  it("runs design, build, open, and two-day settlement with automatic saves", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    let state = createNewGame("save-1");
    const cells = [...createRectangle(0, 0, 8, 8, "bedroom"), ...createRectangle(0, 8, 8, 4, "bathroom")];
    state = await commands.saveRoomBlueprint(state, "云岫商务房", cells);
    for (const slot of ["slot-nw", "slot-ne", "slot-sw", "slot-se"]) state = await commands.placeRoom(state, slot);
    state = await commands.openHotel(state);
    state = await commands.advanceDay(state);
    state = await commands.setRate(state, 160_000);
    state = await commands.advanceDay(state);
    expect(state.reports.map((report) => report.soldRooms)).toEqual([3, 0]);
    expect(await store.load("save-1")).toEqual(state);
  });

  it("does not partially deduct cash when placement fails", async () => {
    const store = new InMemorySavePort();
    const commands = createGameCommands(store);
    const state = createNewGame("save-1");
    await expect(commands.placeRoom(state, "slot-nw")).rejects.toThrow("请先保存房型");
    expect(state.cashCents).toBe(100_000_000);
    expect(await store.load("save-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Verify command modules are missing**

Run: `cd app && npm test -- src/application/gameCommands.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Define the save port and memory adapter**

```ts
// app/src/application/ports/SavePort.ts
import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";

export interface SavePort {
  load(saveId: SaveId): Promise<GameState | null>;
  commit(expectedRevision: number, next: GameState): Promise<void>;
}
```

```ts
// app/src/infrastructure/memory/InMemorySavePort.ts
import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";

export class InMemorySavePort implements SavePort {
  private saves = new Map<string, GameState>();
  async load(saveId: string) { return structuredClone(this.saves.get(saveId) ?? null); }
  async commit(expectedRevision: number, next: GameState) {
    const current = this.saves.get(next.saveId);
    if (current && current.revision !== expectedRevision) throw new Error("存档已更新，请重新加载");
    this.saves.set(next.saveId, structuredClone(next));
  }
}
```

- [ ] **Step 4: Implement the only mutation entry point**

```ts
// app/src/application/gameCommands.ts
import type { SavePort } from "./ports/SavePort";
import type { Cell, GameState } from "../domain/game/state";
import { evaluateRoom } from "../domain/room/evaluateRoom";
import { placeRoom } from "../domain/floor/planFloor";
import { settleDay } from "../domain/simulation/settleDay";

export function createGameCommands(savePort: SavePort) {
  const persist = async (current: GameState, changed: Omit<GameState, "revision">): Promise<GameState> => {
    const next = { ...changed, revision: current.revision + 1 };
    await savePort.commit(current.revision, next);
    return next;
  };
  return {
    async saveRoomBlueprint(state: GameState, name: string, cells: Cell[]) {
      if (state.phase !== "design") throw new Error("当前不能修改房型");
      const metrics = evaluateRoom(cells, 8, 12);
      return persist(state, { ...state, phase: "floor", roomBlueprint: { id: "room-type-1", name, columns: 8, rows: 12, cells, metrics, visual: { status: "idle" } } });
    },
    async placeRoom(state: GameState, slotId: string) {
      if (!state.roomBlueprint) throw new Error("请先保存房型");
      if (state.phase !== "floor" && state.phase !== "ready") throw new Error("当前不能布置楼层");
      const placed = placeRoom(state.floor.rooms, state.roomBlueprint, slotId);
      if (state.cashCents < placed.costCents) throw new Error("资金不足，设计已保留");
      const rooms = placed.rooms;
      return persist(state, { ...state, phase: rooms.length > 0 ? "ready" : "floor", cashCents: state.cashCents - placed.costCents, floor: { ...state.floor, rooms } });
    },
    async setRate(state: GameState, rateCents: number) {
      if (!Number.isSafeInteger(rateCents) || rateCents <= 0) throw new Error("房价必须大于零");
      return persist(state, { ...state, rateCents });
    },
    async openHotel(state: GameState) {
      if (state.floor.rooms.length === 0) throw new Error("至少建造一间客房才能开业");
      return persist(state, { ...state, phase: "open" });
    },
    async advanceDay(state: GameState) {
      if (state.phase !== "open" || !state.roomBlueprint) throw new Error("酒店尚未开业");
      const report = settleDay({ day: state.currentDay + 1, cashCents: state.cashCents, availableRooms: state.floor.rooms.length, rateCents: state.rateCents, suggestedRateCents: state.roomBlueprint.metrics.suggestedRateCents, areaSquareMeters: state.roomBlueprint.metrics.areaSquareMeters });
      return persist(state, { ...state, currentDay: report.day, cashCents: report.endingCashCents, reports: [...state.reports, report], latestReport: report });
    },
  };
}
```

- [ ] **Step 5: Run command and domain tests**

Run: `cd app && npm test -- src/application src/domain`

Expected: all tests pass, including exact two-day occupancy.

- [ ] **Step 6: Commit the application command boundary**

```bash
git add app/src/application app/src/infrastructure/memory
git commit -m "feat: add prototype game commands"
```

### Task 7: Add an Offline Visual Provider and Prove AI Isolation

**Files:**
- Create: `app/public/visuals/prototype-room.svg`
- Create: `app/src/application/ports/VisualProvider.ts`
- Create: `app/src/infrastructure/visual/PlaceholderVisualProvider.ts`
- Create: `app/src/application/requestRoomVisual.ts`
- Create: `app/src/application/requestRoomVisual.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write failing visual-isolation tests**

```ts
// app/src/application/requestRoomVisual.test.ts
import { describe, expect, it } from "vitest";
import { requestRoomVisual } from "./requestRoomVisual";
import type { VisualProvider } from "./ports/VisualProvider";

const economics = { areaSquareMeters: 24, buildCostCents: 11_600_000, suggestedRateCents: 80_000, businessFitBps: 8_500 };

describe("requestRoomVisual", () => {
  it("changes only visual state on success", async () => {
    const provider: VisualProvider = { generate: async () => ({ assetPath: "/visuals/prototype-room.svg" }) };
    const blueprint = { id: "room-type-1", name: "云岫商务房", columns: 8, rows: 12, cells: [], metrics: economics, visual: { status: "idle" as const } };
    const next = await requestRoomVisual(blueprint, provider);
    expect(next.visual).toEqual({ status: "ready", assetPath: "/visuals/prototype-room.svg" });
    expect(next.metrics).toEqual(economics);
  });

  it("preserves economics on failure", async () => {
    const provider: VisualProvider = { generate: async () => { throw new Error("服务不可用"); } };
    const blueprint = { id: "room-type-1", name: "云岫商务房", columns: 8, rows: 12, cells: [], metrics: economics, visual: { status: "idle" as const } };
    const next = await requestRoomVisual(blueprint, provider);
    expect(next.visual).toEqual({ status: "error", message: "服务不可用" });
    expect(next.metrics).toEqual(economics);
  });
});
```

- [ ] **Step 2: Verify visual modules are missing**

Run: `cd app && npm test -- src/application/requestRoomVisual.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Define and implement the provider boundary**

```ts
// app/src/application/ports/VisualProvider.ts
import type { RoomBlueprint } from "../../domain/game/state";
export interface VisualProvider {
  generate(room: RoomBlueprint): Promise<{ assetPath: string }>;
}
```

```ts
// app/src/infrastructure/visual/PlaceholderVisualProvider.ts
import type { VisualProvider } from "../../application/ports/VisualProvider";
export class PlaceholderVisualProvider implements VisualProvider {
  async generate() { return { assetPath: "/visuals/prototype-room.svg" }; }
}
```

```ts
// app/src/application/requestRoomVisual.ts
import type { RoomBlueprint } from "../domain/game/state";
import type { VisualProvider } from "./ports/VisualProvider";

export async function requestRoomVisual(room: RoomBlueprint, provider: VisualProvider): Promise<RoomBlueprint> {
  try {
    const result = await provider.generate(room);
    return { ...room, visual: { status: "ready", assetPath: result.assetPath } };
  } catch (error) {
    return { ...room, visual: { status: "error", message: error instanceof Error ? error.message : "效果图生成失败" } };
  }
}
```

- [ ] **Step 4: Add the deterministic local visual asset**

```svg
<!-- app/public/visuals/prototype-room.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
  <rect width="1600" height="900" fill="#263633"/>
  <rect x="120" y="110" width="1360" height="680" rx="24" fill="#d8c7aa"/>
  <rect x="260" y="390" width="680" height="250" rx="18" fill="#76583f"/>
  <rect x="1040" y="210" width="300" height="420" fill="#789396"/>
  <circle cx="1190" cy="660" r="72" fill="#b79a6e"/>
  <text x="160" y="190" fill="#3c3329" font-size="52">Cloud Inn Prototype Visual</text>
</svg>
```

- [ ] **Step 5: Run visual and all application tests**

Add this command to the object returned by `createGameCommands` so React never persists a visual by bypassing the application boundary:

```ts
async requestVisual(state: GameState, provider: VisualProvider) {
  if (!state.roomBlueprint) throw new Error("请先保存房型");
  const roomBlueprint = await requestRoomVisual(state.roomBlueprint, provider);
  return persist(state, { ...state, roomBlueprint });
},
```

Extend `gameCommands.test.ts` with one success and one failing provider. Assert that each command increments `revision`, persists the new visual state, and leaves `metrics`, `cashCents`, `reports`, and `floor.rooms` equal to their pre-request values.

Add these imports to `gameCommands.ts`:

```ts
import type { VisualProvider } from "./ports/VisualProvider";
import { requestRoomVisual } from "./requestRoomVisual";
```

Run: `cd app && npm test -- src/application`

Expected: all application tests pass and metrics remain byte-for-byte equal across visual success/failure.

- [ ] **Step 6: Commit the isolated visual flow**

```bash
git add app/public app/src/application app/src/infrastructure/visual
git commit -m "feat: add isolated room visual provider"
```

### Task 8: Add SQLite v1 and the Typed Tauri Save Adapter

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/migrations/001_initial.sql`
- Create: `app/src-tauri/src/persistence.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Create: `app/src/infrastructure/tauri/TauriSavePort.ts`
- Create: `app/src/infrastructure/tauri/TauriSavePort.test.ts`

- [ ] **Step 1: Write the failing TypeScript adapter test**

```ts
// app/src/infrastructure/tauri/TauriSavePort.test.ts
import { describe, expect, it, vi } from "vitest";
import { createNewGame } from "../../domain/game/state";
import { TauriSavePort } from "./TauriSavePort";

describe("TauriSavePort", () => {
  it("uses typed load and commit commands", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    const port = new TauriSavePort(invoke);
    const game = createNewGame("save-1");
    expect(await port.load("save-1")).toBeNull();
    await port.commit(0, { ...game, revision: 1 });
    expect(invoke).toHaveBeenNthCalledWith(1, "load_game", { saveId: "save-1" });
    expect(invoke).toHaveBeenNthCalledWith(2, "commit_game", { expectedRevision: 0, game: { ...game, revision: 1 } });
  });
});
```

- [ ] **Step 2: Verify the adapter is missing**

Run: `cd app && npm test -- src/infrastructure/tauri/TauriSavePort.test.ts`

Expected: FAIL with missing module `./TauriSavePort`.

- [ ] **Step 3: Add Rust dependencies and the initial normalized schema**

Add to `app/src-tauri/Cargo.toml` using `cargo add` so Cargo selects compatible locked versions:

```bash
cd app/src-tauri
cargo add rusqlite --features bundled
cargo add serde_json sha2
```

```sql
-- app/src-tauri/migrations/001_initial.sql
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saves (
  save_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  ruleset_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  phase TEXT NOT NULL CHECK(phase IN ('design','floor','ready','open')),
  current_day INTEGER NOT NULL CHECK(current_day >= 0),
  cash_cents INTEGER NOT NULL CHECK(cash_cents >= 0),
  rate_cents INTEGER NOT NULL CHECK(rate_cents > 0),
  latest_report_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_blueprints (
  save_id TEXT PRIMARY KEY REFERENCES saves(save_id) ON DELETE CASCADE,
  blueprint_id TEXT NOT NULL,
  name TEXT NOT NULL,
  columns_count INTEGER NOT NULL,
  rows_count INTEGER NOT NULL,
  cells_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  visual_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_instances (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  blueprint_id TEXT NOT NULL,
  committed_build_cost_cents INTEGER NOT NULL,
  PRIMARY KEY(save_id, instance_id),
  UNIQUE(save_id, slot_id)
);
CREATE TABLE IF NOT EXISTS daily_reports (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  game_day INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY(save_id, game_day)
);
```

- [ ] **Step 4: Implement migration, typed load, and atomic commit in Rust**

Implement these exact public boundaries in `app/src-tauri/src/persistence.rs`; keep serialization structs private to the module and derive `Serialize`/`Deserialize`:

```rust
pub struct SaveRepository { root: std::path::PathBuf }

impl SaveRepository {
    pub fn new(root: std::path::PathBuf) -> Self;
    pub fn load_game(&self, save_id: &str) -> Result<Option<serde_json::Value>, String>;
    pub fn commit_game(&self, expected_revision: i64, game: serde_json::Value) -> Result<(), String>;
}
```

Implementation requirements, each covered by Rust tests in the same module:

```rust
#[test] fn creates_and_migrates_a_new_save_database();
#[test] fn commits_and_loads_all_authoritative_state();
#[test] fn rejects_a_stale_revision_without_partial_writes();
#[test] fn rejects_duplicate_daily_report_without_double_entry();
#[test] fn rolls_back_when_any_insert_fails();
```

The implementation must:

```text
1. Reject save IDs outside [A-Za-z0-9_-].
2. Open <app-data>/saves/<save-id>/save.sqlite3 only.
3. Set foreign_keys=ON, journal_mode=WAL, synchronous=FULL, busy_timeout=5000.
4. Execute 001_initial.sql once and record schema version 1.
5. Parse and validate schemaVersion/saveId/revision before starting writes.
6. Treat a missing save as revision 0, compare current revision to expectedRevision,
   and require incoming revision to equal expectedRevision + 1.
7. Validate that report days are unique in the incoming state. In one transaction,
   upsert saves and the optional blueprint, delete then replace room instances,
   delete then replace daily reports, and commit. Snapshot replacement makes repeated
   non-settlement saves idempotent while UNIQUE(save_id, game_day) rejects malformed input.
8. Return a user-readable conflict or corruption error; never include full JSON in errors.
9. Reconstruct the exact GameState JSON on load.
```

- [ ] **Step 5: Register narrow Tauri commands**

```rust
// app/src-tauri/src/lib.rs additions
mod persistence;
use tauri::Manager;

#[tauri::command]
fn load_game(
    app: tauri::AppHandle,
    save_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    persistence::SaveRepository::new(root).load_game(&save_id)
}

#[tauri::command]
fn commit_game(
    app: tauri::AppHandle,
    expected_revision: i64,
    game: serde_json::Value,
) -> Result<(), String> {
    let root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    persistence::SaveRepository::new(root).commit_game(expected_revision, game)
}
```

Register only `load_game` and `commit_game` in the generated `invoke_handler`.

- [ ] **Step 6: Implement the typed TypeScript adapter**

```ts
// app/src/infrastructure/tauri/TauriSavePort.ts
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriSavePort implements SavePort {
  constructor(private readonly invoke: Invoke = tauriInvoke) {}
  load(saveId: string) { return this.invoke<GameState | null>("load_game", { saveId }); }
  commit(expectedRevision: number, game: GameState) {
    return this.invoke<void>("commit_game", { expectedRevision, game });
  }
}
```

- [ ] **Step 7: Run TypeScript and Rust persistence tests**

Run:

```bash
cd app
npm test -- src/infrastructure/tauri
cargo test --manifest-path src-tauri/Cargo.toml persistence
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: all tests pass, including rollback and stale-revision cases.

- [ ] **Step 8: Commit SQLite persistence**

```bash
git add app/src-tauri app/src/infrastructure/tauri app/package-lock.json
git commit -m "feat: persist prototype saves in SQLite"
```

### Task 9: Build the Three-Step Playable Interface

**Files:**
- Create: `app/src/state/GameProvider.tsx`
- Create: `app/src/state/GameProvider.test.tsx`
- Create: `app/src/pages/RoomDesignPage.tsx`
- Create: `app/src/pages/FloorPlanningPage.tsx`
- Create: `app/src/pages/OperationsPage.tsx`
- Modify: `app/src/app/router.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/styles.css`

- [ ] **Step 1: Write the failing provider/component flow test**

```tsx
// app/src/state/GameProvider.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { GameProvider } from "./GameProvider";
import { RoomDesignPage } from "../pages/RoomDesignPage";

describe("GameProvider", () => {
  it("saves the fixed room fixture through application commands", async () => {
    const user = userEvent.setup();
    render(<GameProvider savePort={new InMemorySavePort()}><RoomDesignPage /></GameProvider>);
    await user.click(await screen.findByRole("button", { name: "载入24㎡示例户型" }));
    expect(screen.getByText("面积 24㎡")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存房型" }));
    expect(screen.getByText("房型已保存" )).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify UI modules are missing**

Run: `cd app && npm test -- src/state/GameProvider.test.tsx`

Expected: FAIL with missing provider/page modules.

- [ ] **Step 3: Implement `GameProvider` as the only React state owner**

Expose this context contract and no raw setter:

```ts
interface GameContextValue {
  state: GameState;
  roomDraft: { cells: Cell[]; activeZone: ZoneKind; tool: "rectangle" | "add" | "erase" };
  message: string | null;
  loadFixture(): void;
  setActiveZone(zone: ZoneKind): void;
  setTool(tool: "rectangle" | "add" | "erase"): void;
  applyDraftRectangle(start: { x: number; y: number }, end: { x: number; y: number }): void;
  applyDraftCell(cell: { x: number; y: number }): void;
  saveBlueprint(): Promise<void>;
  placeRoom(slotId: string): Promise<void>;
  requestVisual(): Promise<void>;
  setRate(rateCents: number): Promise<void>;
  openHotel(): Promise<void>;
  advanceDay(): Promise<void>;
}
```

`roomDraft.ts` contains only the unsaved grid cells and selected drawing tool. Its rectangle and cell commands call the pure `grid.ts` functions. `GameProvider` initializes the draft from the loaded blueprint when one exists, but draft edits do not increment the save revision and do not persist until `saveBlueprint()` succeeds.

`GameProvider` must create `createGameCommands(savePort)`, show an explicit loading state while it loads `save-1`, fall back to `createNewGame("save-1")`, route authoritative changes through commands, and expose player-readable errors without mutating authoritative state after failed commands. While `commands.requestVisual` awaits the `PlaceholderVisualProvider`, expose an ephemeral `visualPending: boolean` for the loading indicator; only the final `ready` or `error` state is authoritative and persisted. Never call `SavePort.commit` from a page/provider and never expose an authoritative `setState`.

- [ ] **Step 4: Implement the three pages with accessible controls**

`RoomDesignPage` requirements:

```text
- 8×12 visible grid, zone selector (bedroom/bathroom), rectangle drag, add/erase paint.
- A "载入24㎡示例户型" button for deterministic tests/tutorial.
- Live area, build cost, business fit, and suggested rate.
- "保存房型" persists the validated blueprint first. "生成效果图" becomes available only after that save succeeds; visual errors never block floor planning or operation.
- Drawing changes `roomDraft` only. Route switching keeps the draft in the mounted provider. A browser reload discards the unsaved draft and returns to the last saved blueprint with a warning; it never silently commits.
```

`FloorPlanningPage` requirements:

```text
- Four visible slot buttons with occupied/available state.
- Room footprint drawn at the slot's true 8×12 cell size relative to the fixed corridor.
- Live cash and committed construction cost.
- Placement errors shown beside the floor; one click never deducts twice.
- "进入经营" navigation enabled once at least one room exists.
```

`OperationsPage` requirements:

```text
- Integer-yuan rate input converted to cents at the boundary.
- Open button, advance-day button, current day and cash.
- Latest report: rooms, occupancy, revenue, costs, net, reasons.
- Report history for day 1 and day 2.
```

- [ ] **Step 5: Replace the Phase 0 routes**

Use hash routes:

```text
/design -> RoomDesignPage
/floor -> FloorPlanningPage
/operations -> OperationsPage
* -> current phase's valid page
```

The app shell shows three progress steps and disables links that are not yet valid. Do not add hotel overview, departments, public spaces, automatic pricing, or settings.

- [ ] **Step 6: Add the minimum approved visual system**

In `app/src/styles.css`, define variables and responsive layout without external assets:

```css
:root {
  font-family: Inter, "PingFang SC", system-ui, sans-serif;
  color: #302920;
  background: #e9e2d6;
  --ink: #263631;
  --paper: #f8f4eb;
  --gold: #b39161;
  --bedroom: #bb966c;
  --bathroom: #8fa0a0;
  --danger: #8b443d;
}
```

The center canvas must remain the largest region. Side panels collapse below 1100px. Controls have visible focus styles and do not rely only on color.

- [ ] **Step 7: Run component and full frontend checks**

Run:

```bash
cd app
npm test -- src/state src/pages
npm run typecheck
npm run build
```

Expected: tests pass and the production build exits 0.

- [ ] **Step 8: Commit the playable interface**

```bash
git add app/src
git commit -m "feat: add prototype design build operate flow"
```

### Task 10: Verify the Complete Closed Loop and Desktop Reload

**Files:**
- Create: `app/e2e/core-loop.spec.ts`
- Create: `docs/testing/phase-1-desktop-smoke.md`

- [ ] **Step 1: Write the browser closed-loop E2E**

```ts
// app/e2e/core-loop.spec.ts
import { expect, test } from "@playwright/test";

test("designs, builds, opens, and compares two deterministic days", async ({ page }) => {
  await page.goto("/#/design");
  await page.getByRole("button", { name: "载入24㎡示例户型" }).click();
  await expect(page.getByText("面积 24㎡")).toBeVisible();
  await page.getByRole("button", { name: "保存房型" }).click();
  await page.getByRole("button", { name: "生成效果图" }).click();
  await expect(page.getByRole("img", { name: "云岫商务房效果图" })).toBeVisible();
  await page.getByRole("link", { name: "布置楼层" }).click();
  for (const name of ["西北房位", "东北房位", "西南房位", "东南房位"]) await page.getByRole("button", { name }).click();
  await expect(page.getByText("已建客房 4")).toBeVisible();
  await page.getByRole("link", { name: "经营" }).click();
  await page.getByRole("button", { name: "开业" }).click();
  await page.getByRole("button", { name: "推进一天" }).click();
  await expect(page.getByText("售出 3 / 4")).toBeVisible();
  await page.getByLabel("基础房价（元）").fill("1600");
  await page.getByRole("button", { name: "保存房价" }).click();
  await page.getByRole("button", { name: "推进一天" }).click();
  await expect(page.getByText("售出 0 / 4")).toBeVisible();
});
```

- [ ] **Step 2: Make browser development use memory persistence explicitly**

Add an application bootstrap factory that selects `InMemorySavePort` only when `window.__TAURI_INTERNALS__` is absent and selects `TauriSavePort` otherwise. This selection belongs in `main.tsx`; no domain or page may test for Tauri.

Run: `cd app && npm run test:e2e`

Expected: Phase 0 navigation and the new core-loop tests pass in Chromium.

- [ ] **Step 3: Write the packaged-desktop persistence checklist**

```markdown
# Phase 1 Desktop Smoke Test

- [ ] Delete only the dedicated `save-1` test save through the app's reset-development-save action.
- [ ] Load the 24㎡ fixture and verify cost ¥116,000 and suggested price ¥800.
- [ ] Save the blueprint, then generate the offline visual; repeat with a failing provider build and verify gameplay remains available.
- [ ] Place four rooms and verify cash decreases by ¥464,000 exactly once.
- [ ] Open at ¥800 and settle day 1: sold 3/4, revenue ¥2,400, costs ¥770, net ¥1,630.
- [ ] Change rate to ¥1,600 and settle day 2: sold 0/4 and costs ¥320.
- [ ] Close the app completely and reopen it.
- [ ] Verify day 2, cash, rate, blueprint zones, four room slots, visual metadata, and both reports are restored.
- [ ] Disconnect networking and repeat one settlement successfully.
- [ ] Confirm the database contains no image Base64 or API token.
```

- [ ] **Step 4: Run all automated checks**

Run:

```bash
cd app
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: every command exits 0.

- [ ] **Step 5: Run the macOS development smoke**

Run: `cd app && npm run tauri dev`

Expected: complete every item in `docs/testing/phase-1-desktop-smoke.md`. Record macOS version, architecture, database location, and commit hash without recording personal paths or secrets.

- [ ] **Step 6: Commit Phase 1 acceptance evidence**

```bash
git add app/e2e docs/testing/phase-1-desktop-smoke.md app/src
git commit -m "test: verify prototype hotel loop"
```

## Phase 1 Completion Gate

Do not begin Phase 2 until:

- The exact 24㎡/four-room/two-day fixture passes unit, component, browser, Rust, and desktop smoke checks.
- Failed commands never partially deduct cash or advance time.
- A stale save revision and duplicate day are rejected atomically.
- Visual success, failure, path, and provider do not change any room metric or settlement field.
- Closing and reopening the Tauri app restores the authoritative state from SQLite.
- No API key, Base64 image, provider response, React object, Pixi object, or Tauri handle appears in domain state or the database.
- Deferred Phase 2-5 features have not been added early.
