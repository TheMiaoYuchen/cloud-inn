# Cloud Inn Phase 4 Content and Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the single-floor Phase 3 hotel into a deterministic, persistent and responsive 120-room tower with twelve public-space types, light facility operations, aggregate pixel flows and player-facing compendia.

**Architecture:** Add an optional authoritative `phase4` envelope to `GameState`, populated by a pure idempotent legacy upgrade. Pure TypeScript modules own building, space, catalog, facility, flow and settlement rules; application commands compose atomic saves; browser and Rust adapters validate equivalent JSON; React and Pixi render projections without calculating economics.

**Tech Stack:** Tauri 2, React 19, TypeScript 5.8, Vite 7, PixiJS 8, SQLite/Rusqlite, Vitest, Testing Library, Playwright, Rust stable.

---

## Delivery Rules

- Work only in the owned Phase 4 worktree and branch created after this plan is approved.
- Follow strict RED -> GREEN for every production behavior; record the failing command and expected failure before implementation.
- Keep money and counts as safe integers; use stable ASCII IDs and deterministic ordering.
- Do not add API Nebula, keychain, backup/export, network retry, signing or Phase 5 release work.
- After every task: focused tests, typecheck, `git diff --check`, one focused commit, specification review, then code-quality review.
- Never proceed with unresolved Critical or Important findings.

## File Structure

### New domain modules

- `app/src/domain/content/contentCatalog.ts`: immutable facilities, items, menus, signature offerings and unlock prerequisites.
- `app/src/domain/content/contentUnlocks.ts`: pure permanent-unlock projection and catalog-progress reconciliation.
- `app/src/domain/content/contentProgress.ts`: catalog/design/market compendium projections.
- `app/src/domain/building/buildingTypes.ts`: Phase 4 building, floor, room, space and template contracts.
- `app/src/domain/building/towerHotel.ts`: tower creation, expansion, floor copy/sync and legacy upgrade.
- `app/src/domain/building/hotelInventory.ts`: authoritative room/facility projections and stable indexes.
- `app/src/domain/spaces/spaceTypes.ts`: neutral cells, zones, openings, items and blueprints.
- `app/src/domain/spaces/spaceEditor.ts`: shared paint/rectangle/erase/opening/item/history operations.
- `app/src/domain/spaces/spaceValidation.ts`: public-space validator strategies and advisory hints.
- `app/src/domain/facilities/facilityTypes.ts`: policies, menus, offerings and daily result contracts.
- `app/src/domain/facilities/facilityOperations.ts`: configuration validation, boosts and deterministic daily settlement.
- `app/src/domain/operations/settleHotelDay.ts`: one atomic room + facility settlement composition.
- `app/src/domain/flows/flowProjection.ts`: bounded deterministic representative flow events.

### New application and persistence modules

- `app/src/application/buildingCommands.ts`: upgrade, expansion, floor copy/sync and inventory reconciliation.
- `app/src/application/spaceCommands.ts`: save blueprint and place/replace public spaces.
- `app/src/application/facilityCommands.ts`: facility policy and signature offering commands.
- `app/src/application/contentQueries.ts`: immutable read projections for overview and compendia.
- `app/src/infrastructure/browser/validatePhase4State.ts`: browser Phase 4 validation.
- `app/src/testing/phase4Fixtures.ts`: shared deterministic legacy, valid 120-room and invalid fixtures.
- `app/src-tauri/tests/fixtures/phase4-valid.json`: valid cross-runtime fixture.
- `app/src-tauri/tests/fixtures/phase4-invalid/*.json`: named invalid fixtures consumed unchanged by TypeScript and Rust.
- `app/playwright.performance.config.ts`: production-preview-only frame-time performance runner.

### New UI modules

- `app/src/pages/BuildingOverviewPage.tsx`: vertical tower, expansion and operating summary.
- `app/src/pages/PublicSpaceDesignPage.tsx`: shared public-space design workflow.
- `app/src/pages/ContentCompendiumPage.tsx`: catalog, design library and market compendium.
- `app/src/components/building/TowerOverview.tsx`: accessible vertical floor selector.
- `app/src/components/building/FloorWorkspace.tsx`: selected-floor true-scale workspace and inspector.
- `app/src/components/facilities/FacilityOperationsPanel.tsx`: result -> reason -> action facility controls.
- `app/src/canvas/HotelFlowCanvas.tsx`: Pixi pooled/capped flow renderer.

## Task 1: Freeze Phase 4 Contracts, Stable IDs and Acceptance Fixtures

**Files:**
- Create: `app/src/domain/building/buildingTypes.ts`
- Create: `app/src/domain/facilities/facilityTypes.ts`
- Create: `app/src/testing/phase4Fixtures.ts`
- Create: `app/src/domain/building/buildingTypes.test.ts`
- Modify: `app/src/domain/game/state.ts`
- Modify: `app/src/domain/game/state.test.ts`

- [ ] **Step 1: Write failing contract and fixture tests**

```ts
it("creates a valid maximum-density fixture with stable floor-scoped IDs", () => {
  const state = createPhase4AcceptanceState("phase4-acceptance");
  expect(state.phase4?.floors).toHaveLength(16);
  expect(projectFixtureRoomIds(state)).toHaveLength(120);
  expect(new Set(projectFixtureRoomIds(state)).size).toBe(120);
  expect(Object.keys(state.phase4?.facilities ?? {})).toHaveLength(12);
});

it("keeps Phase 4 optional for all legacy saves", () => {
  expect(createNewGame("legacy").phase4).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd app && npm test -- src/domain/building/buildingTypes.test.ts src/domain/game/state.test.ts`

Expected: FAIL because `ContentScaleState` and `createPhase4AcceptanceState` do not exist.

- [ ] **Step 3: Define the exact contracts**

```ts
export type FloorUse = "entrance" | "sky-lobby" | "guest" | "facility" | "service";
export type PublicSpaceType =
  | "sky-lobby" | "all-day-dining" | "chinese-restaurant" | "bar"
  | "executive-lounge" | "spa" | "pool" | "gym" | "ballroom"
  | "meeting-room" | "garden-terrace" | "boutique";

export interface ScaleRoomInstance {
  id: string;
  floorId: string;
  localPlacementId: string;
  roomBlueprintId: string;
  variantId?: string;
  committedBuildCostCents: number;
}

export interface HotelFloor {
  id: string;
  floorNumber: number;
  use: FloorUse;
  templateId: string;
  purchased: boolean;
  rooms: ScaleRoomInstance[];
  publicSpaceInstanceIds: string[];
}

export interface ContentScaleState {
  rulesetVersion: "content-scale-v1";
  building: TowerBuildingState;
  floorTemplates: Record<string, ScaleFloorTemplate>;
  floors: HotelFloor[];
  spaceBlueprints: Record<string, PublicSpaceBlueprint>;
  publicSpaces: Record<string, PublicSpaceInstance>;
  facilities: Record<string, FacilityState>;
  catalogProgress: CatalogProgress;
  recentFlowSnapshot: FlowSnapshot | null;
}
```

Add `phase4?: ContentScaleState` to `GameState`. Define branded validation helpers for IDs matching `^[a-z0-9][a-z0-9:-]{0,95}$`, floor count 1-64, room count 0-240 and public-space count 0-32.

- [ ] **Step 4: Build deterministic fixtures**

`createPhase4AcceptanceState(saveId)` must create exactly 16 hotel floors, 120 unique rooms, all twelve facility types, six operating facilities, all six segment inputs and bounded content/flow collections. Freeze fixture order by floor number then stable ID.

- [ ] **Step 5: Run focused and legacy tests**

Run: `cd app && npm test -- src/domain/building/buildingTypes.test.ts src/domain/game/state.test.ts src/domain/operations/operationsTypes.test.ts && npm run typecheck`

Expected: PASS with the new contract tests and all legacy state tests.

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/building app/src/domain/facilities/facilityTypes.ts app/src/testing/phase4Fixtures.ts app/src/domain/game/state.ts app/src/domain/game/state.test.ts
git commit -m "feat: define phase four state contracts"
```

## Task 2: Add Minimal Cross-Runtime Phase 4 Persistence

**Files:**
- Create: `app/src/infrastructure/browser/validatePhase4State.ts`
- Create: `app/src/infrastructure/browser/validatePhase4State.test.ts`
- Create: `app/src-tauri/tests/fixtures/phase4-valid.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/duplicate-floor-id.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/unknown-room-floor.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/unsafe-money.json`
- Modify: `app/src/infrastructure/browser/validateBrowserGameState.ts`
- Modify: `app/src-tauri/src/persistence.rs`
- Modify: `app/src-tauri/migrations/001_initial.sql`

- [ ] **Step 1: Check in one shared valid fixture and named invalid fixtures**

Generate `phase4-valid.json` once from `createPhase4AcceptanceState("phase4-shared")`, review it, then check it in. TypeScript tests must load this checked-in JSON and compare it semantically with the TS fixture. Rust tests consume the same files with `include_str!`. Named invalid JSON files are complete game snapshots, not language-specific mutation closures.

- [ ] **Step 2: Write failing browser and Rust round-trip tests**

```ts
it("matches and accepts the checked-in cross-runtime fixture", () => {
  const json = sharedPhase4Json();
  expect(json).toEqual(JSON.parse(JSON.stringify(createPhase4AcceptanceState("phase4-shared"))));
  expect(() => validateBrowserGameState(json, "phase4-shared")).not.toThrow();
});
```

Rust must load `phase4-valid.json`, commit, reopen and compare the loaded `phase4` value. Each runtime must reject every file under `phase4-invalid/` by its filename-defined invariant.

- [ ] **Step 3: Run tests and verify RED**

Run: `cd app && npm test -- src/infrastructure/browser/validatePhase4State.test.ts && cd src-tauri && cargo test phase4_minimal`

Expected: FAIL because browser validation and SQLite `phase4_json` support do not exist.

- [ ] **Step 4: Add strict minimum browser validation**

Validate the envelope object, ruleset, stable ID syntax, top-level collections, unique floor/room/space IDs, room-to-floor references and safe construction money. Call it from `validateBrowserGameState(value, expectedSaveId)` only when `phase4` exists. Task 8 deepens catalog, blueprint, report and bounded-history invariants.

- [ ] **Step 5: Add idempotent SQLite storage**

Add nullable `phase4_json TEXT`, load it into `game["phase4"]`, validate the same minimum invariants and serialize it on commit. Existing saves without the column migrate and load without `phase4`. Add rollback tests proving an invalid Phase 4 commit leaves the old row and revision unchanged.

- [ ] **Step 6: Run persistence baselines**

Run: `cd app && npm test -- src/infrastructure/browser/validatePhase4State.test.ts && cd src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check`

Expected: PASS for shared Phase 4 fixtures and all Phase 1-3 migrations.

- [ ] **Step 7: Commit**

```bash
git add app/src/infrastructure/browser app/src-tauri/src/persistence.rs app/src-tauri/migrations app/src-tauri/tests/fixtures
git commit -m "feat: persist phase four envelope"
```

## Task 3: Add the Content Catalog and Tower Building Domain

**Files:**
- Create: `app/src/domain/content/contentCatalog.ts`
- Create: `app/src/domain/content/contentCatalog.test.ts`
- Create: `app/src/domain/content/contentUnlocks.ts`
- Create: `app/src/domain/content/contentUnlocks.test.ts`
- Create: `app/src/domain/building/towerHotel.ts`
- Create: `app/src/domain/building/towerHotel.test.ts`
- Modify: `app/src/domain/floor/corridorTemplate.ts`
- Modify: `app/src/domain/floor/corridorTemplate.test.ts`

- [ ] **Step 1: Write failing catalog and tower tests**

```ts
it("exposes all approved facilities in deterministic display order", () => {
  expect(FACILITY_CATALOG.map(({ id }) => id)).toEqual(APPROVED_PUBLIC_SPACE_TYPES);
});

it("upgrades one legacy hotel exactly once without charging cash", () => {
  const legacy = openedLegacyFixture();
  const first = upgradeLegacyToPhase4(legacy);
  const second = upgradeLegacyToPhase4(first);
  expect(second).toEqual(first);
  expect(first.cashCents).toBe(legacy.cashCents);
  expect(projectScaleRooms(first).length).toBeGreaterThanOrEqual(8);
});

it("copies a guest floor with new room IDs and unchanged template references", () => {
  const result = copyGuestFloor(scaleFixture(), "floor:28", 29);
  expect(result.floor.id).toBe("floor:29");
  expect(result.floor.rooms.every(room => room.floorId === "floor:29")).toBe(true);
  expect(new Set(result.floor.rooms.map(room => room.id)).size).toBe(result.floor.rooms.length);
});

it("projects permanent content unlocks from authoritative progress", () => {
  const eligible = scaleFixture({ reputationBps: 7_500, discoveredNeeds: ["need:wellness"] });
  const unlocked = reconcileCatalogProgress(eligible.phase4!, projectContentUnlocks(eligible));
  expect(unlocked.catalogProgress.unlockedIds).toContain("facility:spa");
  const later = reconcileCatalogProgress(unlocked, []);
  expect(later.catalogProgress.unlockedIds).toContain("facility:spa");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/content/contentCatalog.test.ts src/domain/content/contentUnlocks.test.ts src/domain/building/towerHotel.test.ts`

Expected: FAIL on missing catalog, content-unlock and tower modules.

- [ ] **Step 3: Implement immutable catalogs**

Define all twelve facility records with stable ID, name, category, construction cost range, operating mode, required zone IDs, permitted item IDs, default capacity range and unlock rule. Define the first tower and dense ring guest-floor templates. Export `validateContentCatalog()` that rejects duplicate IDs, missing references, unsafe money, invalid ranges and nondeterministic display orders.

- [ ] **Step 4: Implement tower rules and legacy upgrade**

Implement:

```ts
export function upgradeLegacyToPhase4(state: Readonly<GameState>): GameState;
export function previewExpansion(state: Readonly<GameState>, floorNumber: number): ExpansionPreview;
export function applyExpansion(state: Readonly<ContentScaleState>, floorNumber: number): { phase4: ContentScaleState; costCents: number };
export function copyGuestFloor(state: Readonly<ContentScaleState>, sourceFloorId: string, floorNumber: number): FloorCopyResult;
export function previewTemplateSync(state: Readonly<ContentScaleState>, templateId: string): TemplateSyncPreview[];
export function applyTemplateSync(state: Readonly<ContentScaleState>, selectedFloorIds: readonly string[]): ContentScaleState;
```

Upgrade maps legacy rooms into one guest floor, creates entrance/sky-lobby/service markers, preserves design references and reports, and makes no financial or reputation change. `applyExpansion` is pure and returns the required cost; the later `purchaseFloor(GameState)` application command validates cash and commits the charge atomically.

Implement `projectContentUnlocks(GameState): readonly string[]` and `reconcileCatalogProgress(ContentScaleState, readonly string[]): ContentScaleState`. Prerequisites may use reputation, discovered guest needs, built facility types and completed content choices; output uses catalog order and stable IDs. Reconciliation is additive so an earned unlock never relocks. Call it during legacy upgrade, and require Tasks 4, 6 and 7 to call it after successful building/facility mutations and after each daily settlement. Viewing a catalog or compendium never calls it. Catalog tests must prove every prerequisite references a known progress source and every projected ID exists.

- [ ] **Step 5: Generalize the ring template**

Add `createDenseGuestFloorTemplate({ floorId, slotsPerSide: 8 })` with 24-32 true-size outer slots, central core, ring connectivity and deterministic slot IDs. Keep `createCorridorTemplate()` unchanged for Phase 2.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `cd app && npm test -- src/domain/content/contentCatalog.test.ts src/domain/content/contentUnlocks.test.ts src/domain/building/towerHotel.test.ts src/domain/floor/corridorTemplate.test.ts && npm run typecheck`

Expected: PASS, including all existing corridor-template tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/content app/src/domain/building/towerHotel.ts app/src/domain/building/towerHotel.test.ts app/src/domain/floor
git commit -m "feat: add tower and content catalogs"
```

## Task 4: Project 120-Room Inventory and Add Atomic Building Commands

**Files:**
- Create: `app/src/domain/building/hotelInventory.ts`
- Create: `app/src/domain/building/hotelInventory.test.ts`
- Create: `app/src/application/buildingCommands.ts`
- Create: `app/src/application/buildingCommands.test.ts`
- Modify: `app/src/domain/operations/roomOffer.ts`
- Modify: `app/src/domain/operations/matchGuest.test.ts`
- Modify: `app/src/application/pricingContextForState.ts`
- Modify: `app/src/application/gameCommands.ts`

- [ ] **Step 1: Write failing authoritative inventory tests**

```ts
it("uses Phase 4 inventory instead of double-counting legacy rooms", () => {
  const state = createPhase4AcceptanceState("inventory");
  state.floor.rooms.push(structuredClone(state.floor.rooms[0]));
  expect(projectHotelRoomOffers(state)).toHaveLength(120);
  expect(projectHotelInventory(state).rooms).toHaveLength(120);
  state.operations!.dailyReports = [dailyReportFixture({
    availableRooms: 120,
    soldRooms: 60,
    segmentDemand: { business: 60 },
  })];
  expect(pricingContextForState(state).segmentDemandBps).toBe(5_000);
  expect(pricingContextForState(state).remainingInventoryBps).toBe(5_000);
});

it("atomically buys and populates one floor while reconciling pricing", async () => {
  const { state, commands, store } = await initializedScaleCommands();
  const preview = previewExpansion(state, 35);
  const next = await commands.purchaseFloor(state, 35, "dense-ring");
  expect(next.cashCents).toBe(state.cashCents - preview.costCents);
  expect(Object.keys(next.operations!.pricePolicies)).toEqual(projectHotelRoomOffers(next).map(o => o.id));
  await expectSavedRevision(state, next, store);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/building/hotelInventory.test.ts src/application/buildingCommands.test.ts`

Expected: FAIL because authoritative inventory projection and commands are absent.

- [ ] **Step 3: Implement indexed projections**

Create maps for floor, template, room type, variant, placement, policy and upgrade lookup once per projection. Export:

```ts
export function projectHotelInventory(state: Readonly<GameState>): HotelInventory;
export function projectHotelRoomOffers(state: Readonly<GameState>): RoomOffer[];
export function reconcileHotelReferences(state: Readonly<GameState>): GameState;
```

When `phase4` is absent, delegate exactly to the existing Phase 3 projection. When present, sort floors by floor number and rooms by stable ID, project each physical room once and never scan arrays inside the per-room loop.

- [ ] **Step 4: Implement atomic building commands**

Create commands `initializeContentScale`, `purchaseFloor`, `copyFloor` and `syncFloorTemplate`. Each command validates cash and revision, produces the complete next state, reconciles prices/upgrades/facilities, then invokes one `persist`. Add failing-port tests proving source and storage remain unchanged.

Every successful command also runs `reconcileCatalogProgress` with `projectContentUnlocks(nextState)` before its single commit; failed persistence must not expose newly projected unlocks.

- [ ] **Step 5: Switch shared consumers**

Make `projectRoomOffers` a compatibility alias of `projectHotelRoomOffers`; update pricing context and settlement callers to authoritative inventory. Do not change legacy offer IDs or results.

- [ ] **Step 6: Run focused and Phase 3 regressions**

Run: `cd app && npm test -- src/domain/building/hotelInventory.test.ts src/application/buildingCommands.test.ts src/domain/operations/matchGuest.test.ts src/application/gameCommands.test.ts && npm run typecheck`

Expected: PASS with exact Phase 3 settlement snapshots unchanged.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/building/hotelInventory* app/src/application/buildingCommands* app/src/domain/operations/roomOffer.ts app/src/domain/operations/matchGuest.test.ts app/src/application/pricingContextForState.ts app/src/application/gameCommands.ts
git commit -m "feat: scale hotel room inventory"
```

## Task 5: Extract the Shared Space Editor and Public-Space Validators

**Files:**
- Create: `app/src/domain/spaces/spaceTypes.ts`
- Create: `app/src/domain/spaces/spaceEditor.ts`
- Create: `app/src/domain/spaces/spaceEditor.test.ts`
- Create: `app/src/domain/spaces/spaceValidation.ts`
- Create: `app/src/domain/spaces/spaceValidation.test.ts`
- Modify: `app/src/domain/room/editRoom.ts`
- Modify: `app/src/domain/room/editRoom.test.ts`

- [ ] **Step 1: Write failing editor compatibility tests**

```ts
it("edits arbitrary zone IDs without weakening room validation", () => {
  const lobby = createSpaceDraft("sky-lobby", 40, 30);
  const next = paintSpaceRectangle(lobby, { x: 2, y: 2, width: 8, height: 5 }, "reception");
  expect(zoneAt(next, 2, 2)).toBe("reception");
  expect(validateRoomDraft(legacyValidRoomDraft()).ok).toBe(true);
  expect(validateRoomDraft(legacyDisconnectedBathroomDraft())).toEqual({
    ok: false,
    reason: "房间轮廓必须连续",
  });
});

it("snaps, aligns and preserves a connected service route", () => {
  const draft = diningDraftWithServiceRoute();
  const aligned = alignPlacedItems(snapPlacedItem(draft, "table:1", { x: 4, y: 6 }), ["table:1", "table:2"], "left");
  expect(aligned.items.find(item => item.id === "table:2")?.x).toBe(4);
  expect(validateSpaceConnectivity(aligned).serviceRouteConnected).toBe(true);
});

it.each([
  ["sky-lobby", validLobby(), []],
  ["all-day-dining", invalidRestaurantWithoutKitchen(), ["必须设置厨房或备餐区"]],
  ["pool", invalidPoolWithoutDeck(), ["泳池必须设置连续池岸"]],
  ["spa", invalidSpaWithoutPrivacy(), ["护理区私密性不足"]],
  ["ballroom", invalidBallroomWithoutEgress(), ["宴会厅疏散出口不足"]],
])("validates %s with its strategy", (kind, draft, expectedBlocking) => {
  expect(validatePublicSpace(draft).blocking.map(x => x.message)).toEqual(expectedBlocking);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/spaces/spaceEditor.test.ts src/domain/spaces/spaceValidation.test.ts`

Expected: FAIL because neutral editor and validators do not exist.

- [ ] **Step 3: Implement neutral editor contracts**

Define `SpaceCell { x; y; zoneId }`, `PlacedItem { id; catalogItemId; x; y; width; height; rotation }`, openings and `PublicSpaceBlueprint`. Implement immutable paint, erase, rectangle, selection, opening, item placement/rotation, grid snapping, multi-item alignment, undo and redo. Export `snapPlacedItem`, `alignPlacedItems` and `validateSpaceConnectivity`; validate bounds, collision, opening boundaries, zone connectivity, service-route connectivity and maximum cells/items.

- [ ] **Step 4: Adapt room editing without a rewrite**

Move reusable geometry/history helpers into `spaceEditor.ts`; keep `editRoom.ts` exports and Chinese errors stable through adapters converting `zone` to `zoneId`. Run all old room editor/grid tests before proceeding.

- [ ] **Step 5: Implement strategy validators**

Use `SpaceTypeDefinition` from the catalog to dispatch lobby, dining/bar, pool, spa, ballroom/meeting and general boost validators. Return `{ blocking: PlanningIssue[]; advisory: PlanningIssue[]; metrics }`; calculate safe-integer construction cost, capacity, appeal, privacy and service distance.

- [ ] **Step 6: Run focused and full room-design regressions**

Run: `cd app && npm test -- src/domain/spaces src/domain/room src/pages/Phase2DesignRegression.test.tsx && npm run typecheck`

Expected: PASS with unchanged Phase 2 room behavior.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/spaces app/src/domain/room/editRoom.ts app/src/domain/room/editRoom.test.ts
git commit -m "feat: share editor across public spaces"
```

## Task 6: Add Menus, Signature Offerings and Facility Configuration

**Files:**
- Create: `app/src/domain/facilities/facilityOperations.ts`
- Create: `app/src/domain/facilities/facilityOperations.test.ts`
- Create: `app/src/application/spaceCommands.ts`
- Create: `app/src/application/spaceCommands.test.ts`
- Create: `app/src/application/facilityCommands.ts`
- Create: `app/src/application/facilityCommands.test.ts`
- Modify: `app/src/application/gameCommands.ts`

- [ ] **Step 1: Write failing facility and atomic command tests**

```ts
it("configures light operations without ingredient inventory", () => {
  const policy = createFacilityPolicy("all-day-dining", {
    positioningId: "international-luxury",
    priceBandId: "premium",
    capacity: 84,
    openingPolicyId: "breakfast-dinner",
    serviceBudgetCents: 180_000,
    signatureOfferingId: "dish:tea-smoked-duck",
  });
  expect(policy).not.toHaveProperty("inventory");
  expect(validateFacilityPolicy(policy)).toEqual({ ok: true });
});

it.each(["dining", "bar", "spa", "banquet"])(
  "ships 3-5 positioning or service choices for %s",
  group => {
    expect(projectOperatingChoices(group).length).toBeGreaterThanOrEqual(3);
    expect(projectOperatingChoices(group).length).toBeLessThanOrEqual(5);
  },
);

it("saves blueprint, instance and facility atomically", async () => {
  const { state, commands, store } = await scaleCommandFixture();
  const next = await commands.placePublicSpace(state, validDiningBlueprint(), "floor:36");
  expect(next.cashCents).toBeLessThan(state.cashCents);
  expect(next.phase4!.facilities["facility:floor:36:dining"]).toBeDefined();
  await expectSavedRevision(state, next, store);
});

it("charges signature development only once", async () => {
  const { state, commands } = await activeDiningCommandFixture();
  const first = await commands.developSignatureOffering(state, "facility:dining", "dish:tea-smoked-duck");
  const second = await commands.developSignatureOffering(first, "facility:dining", "dish:tea-smoked-duck");
  expect(first.cashCents).toBe(state.cashCents - SIGNATURE_DEVELOPMENT_COST_CENTS);
  expect(second.cashCents).toBe(first.cashCents);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/facilities/facilityOperations.test.ts src/application/spaceCommands.test.ts src/application/facilityCommands.test.ts`

Expected: FAIL on missing facility operations and commands.

- [ ] **Step 3: Implement policies and offerings**

Define one common policy shape with positioning, price band, capacity, opening policy, budget and optional signature offering. Ship and test 3-5 positioning/service choices for each of the four light-operation groups: dining, bar, spa and banquet/meeting. Catalog restaurant/bar menu structures and 3-5 signature choices; represent spa and banquet signatures as 3-5 service packages using the same offering contract. Validate compatibility, safe money, capacity and authoritative `catalogProgress` unlock state.

- [ ] **Step 4: Implement atomic space commands**

`savePublicSpaceBlueprint` rejects blocking validator issues. `placePublicSpace` validates floor use, capacity, duplicate placement and cash, then writes blueprint/instance/facility/cash in one commit. Replacement refunds only the previous committed construction value and removes or migrates compatible facility state explicitly.

- [ ] **Step 5: Implement atomic facility commands**

`configureFacility`, `developSignatureOffering`, `selectSignatureOffering` and `setFacilityEnabled` preserve all unrelated state. Development cost is charged once per facility/offering pair; failing-port tests prove no partial charge.

Each successful facility or space mutation reconciles permanent content unlocks before the one commit. Tests prove locked choices are rejected, newly eligible choices become usable after reconciliation, and retrying a failed commit neither charges nor unlocks content.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `cd app && npm test -- src/domain/facilities src/application/spaceCommands.test.ts src/application/facilityCommands.test.ts src/application/gameCommands.test.ts && npm run typecheck`

Expected: PASS including the legacy command facade tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/facilities app/src/application/spaceCommands* app/src/application/facilityCommands* app/src/application/gameCommands.ts
git commit -m "feat: configure public facilities"
```

## Task 7: Refactor Settlement Stages and Compose Report v2 Exactly Once

**Files:**
- Create: `app/src/domain/operations/settleHotelDay.ts`
- Create: `app/src/domain/operations/settleHotelDay.test.ts`
- Create: `app/src/domain/operations/settleRoomDemand.ts`
- Create: `app/src/domain/operations/settleRoomDemand.test.ts`
- Modify: `app/src/domain/facilities/facilityOperations.ts`
- Modify: `app/src/domain/facilities/facilityOperations.test.ts`
- Modify: `app/src/domain/operations/operationsTypes.ts`
- Modify: `app/src/domain/operations/reporting.ts`
- Modify: `app/src/domain/operations/reporting.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write failing mixed-hotel settlement tests**

```ts
it("replays the same 120-room mixed hotel for 30 identical days", () => {
  const first = replayHotelDays(createPhase4SettlementFixture(), 30);
  const second = replayHotelDays(createPhase4SettlementFixture(), 30);
  expect(second).toEqual(first);
  expect(first.operations.dailyReports).toHaveLength(30);
});

it("keeps exact report-v2 arithmetic", () => {
  const report = settleHotelDay(createPhase4SettlementInput()).report;
  expect(report.revenueCents).toBe(report.roomRevenueCents! + report.publicSpaceRevenueCents!);
  expect(report.operatingCostCents).toBe(report.departmentCostCents! + report.facilityOperatingCostCents!);
  expect(report.netIncomeCents).toBe(report.revenueCents - report.operatingCostCents - report.financeCostCents);
});

it("finalizes finance, loans and reputation exactly once", () => {
  const input = phase4LoanAndShortfallInput();
  const result = settleHotelDay(input);
  expect(result.report.loanInterestCents).toBe(expectedOneDayInterest(input.operations.loans));
  expect(result.operations.loans).toEqual(expectedOneFinancePassLoans(input));
  expect(result.report.endingCashCents).toBe(expectedOnePassCash(input));
  expect(result.report.reputationDeltaBps).toBe(expectedCombinedReputationDelta(input));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/operations/settleHotelDay.test.ts src/domain/operations/reporting.test.ts`

Expected: FAIL because public-space totals and hotel composition are missing.

- [ ] **Step 3: Extract room demand and service settlement before finance**

Extract a pure `settleRoomDemand()` from the current `settleOperationsDay()`. It returns bookings, segment results, room revenue, department cost, service/lost-booking reasons, reviews, discovered needs, reputation evidence and renovation progress, but it must not calculate loan interest, safety loans, ending cash, final reputation/unlocks or reports. Keep `settleOperationsDay()` as a Phase 3 compatibility wrapper that calls `settleRoomDemand()` and then the shared finalizer exactly once; its existing snapshots must remain byte-for-byte equal.

- [ ] **Step 4: Implement deterministic facility settlement**

For each enabled facility in stable ID order, derive resident/non-resident demand from day seed, occupancy, segment mix, capacity, policy, design metrics, department capacity and reputation. Aggregate covers/visits instead of creating person objects. Return revenue, food/service cost, utilization, satisfaction/appeal deltas, reasons and at most 150 flow events.

- [ ] **Step 5: Compose room and facility results, then finalize once**

`settleHotelDay` calls `settleRoomDemand()` with authoritative room offers and calls facility settlement. It combines revenue, operating cost, finance inputs and reputation evidence, then invokes one shared hotel finalizer that performs loan interest, cash shortfall/safety-loan handling, ending cash, reputation, unlocks and report creation exactly once. Do not call `settleOperationsDay()`, do not run finance twice, do not re-run room matching and do not let flow output feed economics.

After the finalizer has produced the new reputation and discovered needs, reconcile Phase 4 content unlocks once into the returned state. This reconciliation is pure, permanent and part of the same application commit; it never changes finance or creates a second report.

- [ ] **Step 6: Extend compatible reports**

Add optional `roomRevenueCents`, `publicSpaceRevenueCents`, `departmentCostCents` and `facilityOperatingCostCents` to daily/weekly/monthly contracts. New Phase 4 reports require exact category sums for room revenue, public-space revenue, department cost, facility cost and finance cost; old reports with none of the Phase 4 fields retain Phase 3 validation. Aggregate and test every category independently in weekly/monthly reporting without changing Phase 3 snapshots.

- [ ] **Step 7: Switch Phase 4 day commands**

`advanceDay`, batch and offline settlement dispatch to `settleHotelDay` only when `phase4` exists. Maintain the 30-day horizon, automatic pricing, command queue, checkpoint and one-commit atomicity.

- [ ] **Step 8: Run settlement and reporting regressions**

Run: `cd app && npm test -- src/domain/facilities src/domain/operations/settleRoomDemand.test.ts src/domain/operations/settleHotelDay.test.ts src/domain/operations/settleOperationsDay.test.ts src/domain/operations/finance.test.ts src/domain/operations/reporting.test.ts src/application/gameCommands.test.ts && npm run typecheck`

Expected: PASS with deterministic 30-day Phase 3 and Phase 4 replays.

- [ ] **Step 9: Commit**

```bash
git add app/src/domain/facilities app/src/domain/operations app/src/application/gameCommands*
git commit -m "feat: settle rooms and facilities together"
```

## Task 8: Deepen Phase 4 Browser and SQLite Validation

**Files:**
- Modify: `app/src/infrastructure/browser/validatePhase4State.ts`
- Modify: `app/src/infrastructure/browser/validatePhase4State.test.ts`
- Modify: `app/src-tauri/tests/fixtures/phase4-valid.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/unknown-catalog-reference.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/bad-report-arithmetic.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-flow-events.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-floors.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-rooms.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-cells.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-items.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/excessive-history.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/forbidden-credential.json`
- Create: `app/src-tauri/tests/fixtures/phase4-invalid/forbidden-base64.json`
- Modify: `app/src/infrastructure/browser/validateBrowserGameState.ts`
- Modify: `app/src/infrastructure/browser/validateOperationsState.test.ts`
- Modify: `app/src-tauri/src/persistence.rs`
- Modify: `app/src-tauri/migrations/001_initial.sql`

- [ ] **Step 1: Write failing shared fixture tests**

```ts
it("accepts the shared maximum Phase 4 fixture", () => {
  expect(() => validateBrowserGameState(validPhase4Json(), "phase4-shared")).not.toThrow();
});

it.each(sharedInvalidPhase4Fixtures())("rejects shared fixture %s", (_name, value) => {
  expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("内容规模存档");
});
```

`sharedInvalidPhase4Fixtures()` uses eager JSON imports to enumerate every checked-in file under `app/src-tauri/tests/fixtures/phase4-invalid/`; Rust enumerates the same directory during tests. Add a manifest assertion for the exact expected filenames so either runtime fails if a case is omitted. Add named complete JSON snapshots for bad references, unknown catalog/progress IDs, wrong report sums, excessive floors/rooms/cells/items/history/flow events and credential/Base64-like forbidden fields. No language-specific mutation defines persistence truth, and each fixture asserts its filename-specific error class in both runtimes.

- [ ] **Step 2: Run browser and Rust tests and verify RED**

Run: `cd app && npm test -- src/infrastructure/browser/validatePhase4State.test.ts && cd src-tauri && cargo test phase4`

Expected: FAIL because Task 2's minimum validator still accepts the new unknown catalog/progress references, bad report arithmetic and over-limit collections.

- [ ] **Step 3: Implement browser validation**

Validate the complete envelope with explicit bounds: at most 64 floors, 240 rooms, 32 public spaces/facilities, 8,192 cells per blueprint, 256 items per blueprint, 150 flow events and bounded strings. Verify every catalog and catalog-progress reference, uniqueness of permanent unlock IDs, and exact report arithmetic. Call it from `validateBrowserGameState` only when `phase4` exists.

- [ ] **Step 4: Deepen SQLite validation without changing storage shape**

Extend the Task 2 validator with catalog, blueprint, report and bounded-history invariants. Do not add a second column or change old prototype room tables.

- [ ] **Step 5: Implement equivalent Rust validation**

Mirror TypeScript allowlists, limits and cross-reference checks. Reuse the shared valid fixture and keep mutation cases paired by name. Ensure invalid Phase 4 data rolls back the entire transaction.

- [ ] **Step 6: Run complete persistence gates**

Run: `cd app && npm test -- src/infrastructure/browser src/application/gameCommands.test.ts && cd src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check`

Expected: PASS for new maximum fixtures and all Phase 1-3 migration/round-trip tests.

- [ ] **Step 7: Commit**

```bash
git add app/src/infrastructure/browser app/src-tauri/src/persistence.rs app/src-tauri/migrations app/src-tauri/tests
git commit -m "feat: persist phase four hotel scale"
```

## Task 9: Build the Vertical Tower Overview and Multi-Floor Workspace

**Files:**
- Create: `app/src/pages/BuildingOverviewPage.tsx`
- Create: `app/src/pages/BuildingOverviewPage.test.tsx`
- Create: `app/src/components/building/TowerOverview.tsx`
- Create: `app/src/components/building/FloorWorkspace.tsx`
- Create: `app/src/components/building/building.css`
- Modify: `app/src/pages/HotelOverviewPage.tsx`
- Modify: `app/src/pages/FloorPlanningPage.tsx`
- Modify: `app/src/app/router.tsx`
- Modify: `app/src/app/AppShell.tsx`
- Modify: `app/src/state/GameProvider.tsx`

- [ ] **Step 1: Write failing accessible UI tests**

```tsx
it("shows the full tower in physical order and opens one selected floor", async () => {
  renderScaleApp(createPhase4AcceptanceState("tower"));
  const floors = await screen.findAllByRole("button", { name: /层/ });
  expect(floors).toHaveLength(16);
  await userEvent.click(screen.getByRole("button", { name: /28层.*客房/ }));
  expect(screen.getByRole("region", { name: "28层平面工作区" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "29层平面工作区" })).not.toBeInTheDocument();
});

it("previews expansion cost before one atomic purchase", async () => {
  await userEvent.click(screen.getByRole("button", { name: "查看35层扩建" }));
  expect(screen.getByText(/扩建成本/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "确认购买35层" }));
  expect(await screen.findByText(/35层已纳入酒店/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/pages/BuildingOverviewPage.test.tsx`

Expected: FAIL because the tower page and components do not exist.

- [ ] **Step 3: Implement building queries and provider commands**

Expose building/floor projections and new command modules through the existing serialized `GameProvider` queue. Preserve lifecycle generation guards and pending counts; do not add a second mutation queue.

- [ ] **Step 4: Implement the tower overview**

Render floors highest-to-lowest with use, purchased state, room/facility count, open/closed status and expansion action. Default legacy saves retain the existing start/design experience; converted saves route to the tower.

- [ ] **Step 5: Implement the floor workspace**

Use a dominant center plan, collapsible vertical rail and inspector. Show true-size room/space rectangles, room status overlays and selected-floor totals. Mount detailed content for only one floor; use memoized maps rather than repeated `find`.

- [ ] **Step 6: Run UI and navigation regressions**

Run: `cd app && npm test -- src/pages/BuildingOverviewPage.test.tsx src/pages/Phase2FloorRegression.test.tsx src/pages/Phase3OperationsRegression.test.tsx src/state/GameProvider.test.tsx && npm run typecheck`

Expected: PASS for Phase 4 tower and legacy routes.

- [ ] **Step 7: Commit**

```bash
git add app/src/pages app/src/components/building app/src/app app/src/state/GameProvider.tsx
git commit -m "feat: navigate the tower hotel"
```

## Task 10: Add Public-Space Design and Facility Operations UI

**Files:**
- Create: `app/src/pages/PublicSpaceDesignPage.tsx`
- Create: `app/src/pages/PublicSpaceDesignPage.test.tsx`
- Create: `app/src/components/facilities/FacilityOperationsPanel.tsx`
- Create: `app/src/components/facilities/FacilityOperationsPanel.test.tsx`
- Modify: `app/src/pages/OperationsPage.tsx`
- Modify: `app/src/app/router.tsx`
- Modify: `app/src/app/AppShell.tsx`
- Modify: `app/src/state/GameProvider.tsx`

- [ ] **Step 1: Write failing design and operations UI tests**

```tsx
it("designs a restaurant with blocking issues before save", async () => {
  renderScaleApp(scaleDesignFixture());
  await userEvent.selectOptions(screen.getByLabelText("公共空间类型"), "all-day-dining");
  await userEvent.click(screen.getByRole("button", { name: "验证空间" }));
  expect(screen.getByRole("alert")).toHaveTextContent("必须设置厨房或备餐区");
  expect(screen.getByRole("button", { name: "保存公共空间" })).toBeDisabled();
});

it("shows facility result, reason and action and persists a policy", async () => {
  renderScaleApp(activeFacilityFixture());
  const region = screen.getByRole("region", { name: "设施经营" });
  expect(within(region).getByText(/昨日收入/)).toBeInTheDocument();
  expect(within(region).getByText(/容量利用/)).toBeInTheDocument();
  await userEvent.selectOptions(within(region).getByLabelText("价格定位"), "premium");
  await userEvent.click(within(region).getByRole("button", { name: "保存设施策略" }));
  expect(await within(region).findByRole("status")).toHaveTextContent("已保存");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/pages/PublicSpaceDesignPage.test.tsx src/components/facilities/FacilityOperationsPanel.test.tsx`

Expected: FAIL because the pages and panels do not exist.

- [ ] **Step 3: Implement the shared design page**

Provide space-type selection, grid tools, zones, items, openings, undo/redo, property inspector, cost/capacity/appeal metrics and blocking/advisory issue lists. Reuse the neutral editor; never recalculate rules in React.

- [ ] **Step 4: Implement facility operations in result -> reason -> action order**

Show yesterday/month-to-date revenue, cost, utilization and guest effect; then bottleneck reasons; then positioning, price, capacity, opening, budget and signature offering controls. Remount offer-specific local preview state when facility selection changes.

- [ ] **Step 5: Connect serialized commands and routes**

Expose space/facility commands through `GameProvider`, add routes and accessible navigation. Pending/error behavior matches Phase 3 commands; facility failure never blocks room operations.

- [ ] **Step 6: Run focused and operations regressions**

Run: `cd app && npm test -- src/pages/PublicSpaceDesignPage.test.tsx src/components/facilities src/pages/Phase3OperationsRegression.test.tsx src/state/GameProvider.test.tsx && npm run typecheck`

Expected: PASS with all operations actions serialized.

- [ ] **Step 7: Commit**

```bash
git add app/src/pages/PublicSpaceDesignPage* app/src/components/facilities app/src/pages/OperationsPage.tsx app/src/app app/src/state/GameProvider.tsx
git commit -m "feat: operate public hotel spaces"
```

## Task 11: Add Content, Design and Market Compendia

**Files:**
- Create: `app/src/domain/content/contentProgress.ts`
- Create: `app/src/domain/content/contentProgress.test.ts`
- Create: `app/src/application/contentQueries.ts`
- Create: `app/src/application/contentQueries.test.ts`
- Create: `app/src/pages/ContentCompendiumPage.tsx`
- Create: `app/src/pages/ContentCompendiumPage.test.tsx`
- Modify: `app/src/app/router.tsx`
- Modify: `app/src/app/AppShell.tsx`

- [ ] **Step 1: Write failing read-projection tests**

```ts
it("does not unlock content merely by viewing the compendium", () => {
  const state = createPhase4AcceptanceState("compendium");
  const snapshot = structuredClone(state);
  const projection = projectCompendia(state);
  expect(projection.market.entries).toContainEqual(expect.objectContaining({ segmentId: "business" }));
  expect(state).toEqual(snapshot);
});

it("shows where every saved design is used", () => {
  const projection = projectDesignLibrary(createPhase4AcceptanceState("library"));
  expect(projection.entries.every(entry => entry.usageFloorIds.length > 0)).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/content/contentProgress.test.ts src/application/contentQueries.test.ts src/pages/ContentCompendiumPage.test.tsx`

Expected: FAIL because projections and page are missing.

- [ ] **Step 3: Implement immutable progress and queries**

Project locked/unlocked facilities/items/menus with effects and prerequisites; project hotel gene, series, room variants and public-space blueprints with floor usage; project six market segments, discovered needs, facility interests and report evidence. Sort by catalog order and never mutate or unlock state.

- [ ] **Step 4: Implement the accessible compendium**

Add three tabs: `内容目录`, `设计系列`, `市场洞察`. Preserve tab selection in URL search parameters, show explicit locked reasons, and link usages to floor/design routes.

- [ ] **Step 5: Run focused and routing tests**

Run: `cd app && npm test -- src/domain/content src/application/contentQueries.test.ts src/pages/ContentCompendiumPage.test.tsx src/pages/Phase3OperationsRegression.test.tsx && npm run typecheck`

Expected: PASS with no command call when opening or filtering the compendium.

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/content app/src/application/contentQueries* app/src/pages/ContentCompendiumPage* app/src/app
git commit -m "feat: add hotel content compendia"
```

## Task 12: Add Bounded Aggregate Pixel Flows and Performance Gates

**Files:**
- Create: `app/src/domain/flows/flowProjection.ts`
- Create: `app/src/domain/flows/flowProjection.test.ts`
- Create: `app/src/canvas/HotelFlowCanvas.tsx`
- Create: `app/src/canvas/HotelFlowCanvas.test.tsx`
- Create: `app/src/testing/phase4Performance.test.ts`
- Create: `app/e2e/phase4-render-performance.spec.ts`
- Create: `app/playwright.performance.config.ts`
- Create: `docs/testing/phase-4-performance.md`
- Modify: `app/src/components/building/FloorWorkspace.tsx`
- Modify: `app/src/canvas/viewport.ts`

- [ ] **Step 1: Write failing deterministic and bounded flow tests**

```ts
it("projects the same representative flows with a hard cap", () => {
  const state = createPhase4AcceptanceState("flows");
  const first = projectFlowSnapshot(state, "floor:28");
  const second = projectFlowSnapshot(state, "floor:28");
  expect(second).toEqual(first);
  expect(first.events.length).toBeLessThanOrEqual(150);
  expect(first.events.map(event => event.kind)).toEqual(expect.arrayContaining(["guest", "staff", "luggage", "cleaning", "room-service"]));
});

it("settles the maximum fixture inside the agreed budget", () => {
  const elapsed = measureWarmPhase4Replay(30);
  expect(elapsed).toBeLessThan(2_000);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd app && npm test -- src/domain/flows/flowProjection.test.ts src/canvas/HotelFlowCanvas.test.tsx src/testing/phase4Performance.test.ts`

Expected: FAIL because flow projection, renderer and performance harness are absent.

- [ ] **Step 3: Implement deterministic aggregate flows**

Derive representative events from latest bookings, facility utilization, department bottlenecks and selected-floor geometry. Stable-hash and sample events by day/seed; include no individual schedule; bound strings and coordinates; store no more than 150 events.

- [ ] **Step 4: Implement the resilient Pixi renderer**

Create one Pixi application per mounted selected floor, pool sprites by kind, reuse textures, cull offscreen events and destroy all resources on unmount. If initialization throws, render a static status overlay and keep floor controls usable.

- [ ] **Step 5: Add measurable scale tests**

The current-Mac gate uses the 120-room fixture and asserts: warm single-day settlement <=100 ms, 30 days <=2 seconds, selected-floor query <=100 ms, browser save/load harness <=1 second each, no more than 150 sprites and only one detailed floor scene.

Create a dedicated Playwright performance config whose web server runs `npm run preview` against a prior `VITE_CLOUD_INN_E2E=true npm run build`; it must never use the normal Vite development server. The performance spec performs a fixed 10-second pan/zoom trace on the maximum selected floor, collects `requestAnimationFrame` deltas in that production build, discards warm-up frames and fails when p95 exceeds 33 ms. A current-Mac measurement records browser/WebKit process resident memory before and after loading the maximum fixture; the delta must remain below 200 MB. Record commands, samples and observed values in `phase-4-performance.md`; do not loosen budgets automatically. If an automated RSS probe is unavailable in WKWebView, mark RSS as pending in Task 12 rather than inferring it; the Task 13 native smoke must then measure process RSS before final acceptance.

- [ ] **Step 6: Run canvas, scale and full unit gates**

Run: `cd app && npm test -- src/domain/flows src/canvas src/testing/phase4Performance.test.ts && npm test && npm run typecheck && VITE_CLOUD_INN_E2E=true npm run build && npm run test:e2e -- e2e/phase4-render-performance.spec.ts --config playwright.performance.config.ts`

Expected: PASS, including the production-preview 10-second p95 gate; only the already documented Vite chunk-size warning may remain. Record the exact timing samples and whether RSS is measured or pending before committing.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/flows app/src/canvas app/src/testing/phase4Performance.test.ts app/e2e/phase4-render-performance.spec.ts app/playwright.performance.config.ts docs/testing/phase-4-performance.md app/src/components/building/FloorWorkspace.tsx
git commit -m "feat: visualize bounded hotel flows"
```

## Task 13: Verify the Phase 4 Browser Loop, Native Build and Phase Gate

**Files:**
- Create: `app/e2e/phase4-content-scale.spec.ts`
- Create: `docs/testing/phase-4-desktop-smoke.md`
- Create: `app/src-tauri/tauri.phase4-smoke.conf.json`
- Modify: `app/e2e/core-loop.spec.ts`
- Modify: `app/playwright.config.ts`
- Modify: `docs/superpowers/plans/2026-07-27-phase-4-content-scale-plan.md`

- [x] **Step 1: Write the failing browser acceptance**

The test must visibly perform:

1. load a Phase 3 legacy hotel and initialize Phase 4 without financial change;
2. open the tower and select multiple guest/facility floors;
3. buy/copy a floor and reach at least 120 rooms;
4. design and place one restaurant plus at least five other approved facilities;
5. configure a menu/signature offering and one spa or banquet package;
6. operate 30 deterministic days and inspect room/facility report categories;
7. open all three compendia and observe aggregate flows;
8. reload and restore exact building, cash, facilities, reports and selected content.

- [x] **Step 2: Run E2E and verify RED**

Run: `cd app && npm run test:e2e -- e2e/phase4-content-scale.spec.ts`

Expected: FAIL until final selectors and full integration are present.

- [x] **Step 3: Add only necessary accessible integration glue**

Use visible Chinese roles/names and production routes. Do not add hidden fixture-only controls; use the existing E2E environment boundary only for deterministic time and initial local persistence.

- [x] **Step 4: Run the complete automated gate**

```bash
cd app
npm run typecheck
npm test
npm run build
npm run test:e2e
VITE_CLOUD_INN_E2E=true npm run build
npm run test:e2e -- e2e/phase4-render-performance.spec.ts --config playwright.performance.config.ts
cd src-tauri
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --check
cd ../..
git diff --check
```

Expected: zero failures. Record exact Vitest, Playwright and Rust totals.

- [x] **Step 5: Build and smoke-test the debug macOS application**

Run: `cd app && npm run tauri -- build --debug --bundles app,dmg --ci --no-sign --config src-tauri/tauri.phase4-smoke.conf.json`

The smoke config uses product name `Cloud Inn Phase 4 Smoke` and bundle identifier `com.cloudinn.game.phase4-smoke`, isolating its app-data directory from the player's normal `com.cloudinn.game` data. Record macOS/architecture/source commit, bundle paths, timestamps and the resolved absolute smoke database path. If the smoke app-data directory already exists, move that exact resolved directory to a timestamped `/tmp/cloud-inn-phase4-smoke-backup-*` location before testing; never overwrite or delete it.

Create a temporary owned worktree at the Phase 3 final commit. Because that old commit does not contain the new smoke config, invoke its build with the absolute path to `app/src-tauri/tauri.phase4-smoke.conf.json` in the owned Phase 4 worktree as a read-only configuration input. Build and launch the Phase 3 debug app with that smoke bundle identifier and produce a real Phase 3 `save-1` SQLite database under the isolated smoke app-data path. Quit, record its revision and SHA-256, and copy that one database to a timestamped `/tmp/cloud-inn-phase3-save-*` backup. Remove only this owned temporary worktree after verification. Then launch the final Phase 4 smoke app against the same isolated row, initialize Phase 4, quit/reopen, and verify the old room/operations history plus new `phase4` state and revision. Verify 120-room tower navigation, facility operations, flow rendering or static fallback, one settlement, quit/reopen restoration and the required RSS memory delta. Rust tests separately prove failed legacy upgrade/commit leaves the old SQLite row and revision unchanged. Accurately mark any unperformed check rather than inferring it.

- [ ] **Step 6: Request final independent reviews**

Dispatch one specification reviewer against the approved Phase 4 design and this plan, then one whole-diff code-quality reviewer. Resolve every Critical/Important finding with a new RED -> GREEN regression, re-run focused gates, rebuild native bundles and re-run the production-preview performance spec after the last code fix, then repeat review until both approve.

- [ ] **Step 7: Commit the acceptance record**

```bash
git add app/e2e app/playwright.config.ts app/src-tauri/tauri.phase4-smoke.conf.json docs/testing/phase-4-desktop-smoke.md docs/superpowers/plans/2026-07-27-phase-4-content-scale-plan.md
git commit -m "test: verify phase four hotel scale"
```

- [ ] **Step 8: Merge and clean up**

Run the final full gate on the feature branch, fast-forward merge into `main`, run merged typecheck/Vitest/Rust tests, preserve root `.DS_Store` and `初步设想.md`, remove only the owned Phase 4 worktree/branch, record the exit summary, and begin the Phase 5 detailed design under the standing continuous-execution authorization.

## Plan Self-Review

- Task 1 freezes the authoritative envelope, limits, stable IDs and 120-room fixture before parallel content work.
- Task 2 makes the envelope persist and round-trip in both runtimes before any Phase 4 command can claim atomicity.
- Tasks 3-4 cover tower foundations, expansion, templates, 100+ true inventory and pricing/operations compatibility.
- Tasks 5-6 cover one shared editor, alignment/connectivity, all twelve public-space types, menus and signature offerings without inventory.
- Task 7 separates room/facility calculation from one-time finance/reputation finalization and exact mixed-hotel reports.
- Task 8 deepens browser/SQLite equivalence, legacy compatibility and no save corruption with shared fixture files.
- Tasks 9-11 cover the vertical overview, multi-floor workspace, facility design/operations and all three compendia.
- Task 12 covers aggregate pixel flows and measured frame-time/memory/density budgets without individual simulation.
- Task 13 covers the browser/native Phase 4 exit gate, real Phase 3 SQLite upgrade, final reviews, merge and cleanup.
- Phase 5 API Nebula, keychain, networking, backup, export/import and release work is not introduced.
- Function names and types are consistent across tasks: `ContentScaleState`, `projectHotelRoomOffers`, `PublicSpaceBlueprint`, `FacilityState`, `settleHotelDay`, `FlowSnapshot`.
- The plan contains no unresolved placeholders, ambiguous ownership or unbounded collections.
