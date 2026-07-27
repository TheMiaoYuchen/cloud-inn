# Phase 3 Operations Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 2 hotel into a deterministic, low-pressure 30-day operation loop where six guest segments, room fit, pricing, department service, reputation, loans, and daily/weekly/monthly reports produce explainable results.

**Architecture:** Pure TypeScript content catalogs and simulation functions own every gameplay number. `GameState.operations` is an optional versioned envelope so Phase 1/2 saves remain loadable; application commands initialize it lazily and persist each action atomically through the existing `SavePort`. React renders projections in result -> reason -> action order, while Rust and browser adapters validate the same persisted contracts without calculating outcomes.

**Tech Stack:** Existing Tauri 2, React, TypeScript, Vite, Vitest, Testing Library, Playwright, Rust rusqlite/serde_json, SQLite.

---

## Frozen Phase 3 Decisions

- Use six segments: business, couple, family, leisure, high-net-worth, and cultural-experience.
- Derive room offers from the saved blueprint, Phase 2 room variant, area, bed type, view, and design gene. Phase 3 does not add a furniture catalog.
- Hard requirements reject bookings before preference, price, reputation, or service scoring.
- Allocate demand deterministically by day, segment priority, room fit, and stable IDs; no network or `Math.random()`.
- Manage six aggregate departments: front office, housekeeping, food and beverage, engineering, security, and guest relations. No individual schedules.
- Default to casual difficulty. Casual mode uses an explicit safety loan instead of allowing negative cash; management mode rejects unaffordable actions and exposes restructuring pressure without ending the save.
- Store money in integer cents, ratios in basis points, and time in integer game days.
- Daily summaries, weekly reports, and monthly closes are local rule output. Optional AI prose remains out of scope.
- Offline catch-up accepts an application-supplied elapsed duration, settles at most seven days, and never reads the wall clock inside the domain.
- Keep the Phase 1 `DailyReport` projection readable and backward compatible while adding richer Phase 3 reports beside it.

## Task 1: Freeze Operations Contracts and Backward-Compatible Defaults

**Files:**
- Create: `app/src/domain/operations/operationsTypes.ts`
- Create: `app/src/domain/operations/createOperationsState.ts`
- Create: `app/src/domain/operations/operationsTypes.test.ts`
- Modify: `app/src/domain/game/state.ts`
- Modify: `app/src/domain/game/state.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
it("creates the approved casual operations envelope without changing legacy state", () => {
  const game = createNewGame("phase-3");
  const operations = createOperationsState("casual");
  expect(operations.difficulty).toBe("casual");
  expect(operations.reputationBps).toBe(5_000);
  expect(Object.keys(operations.departments)).toEqual([
    "frontOffice", "housekeeping", "foodAndBeverage",
    "engineering", "security", "guestRelations",
  ]);
  expect(game.operations).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/operationsTypes.test.ts src/domain/game/state.test.ts`

Expected: FAIL because `operationsTypes` and `createOperationsState` do not exist.

- [ ] **Step 3: Define the persisted contracts**

Define exact discriminated types for `GuestSegmentId`, `Difficulty`, `DepartmentId`, `DepartmentState`, `RoomPricePolicy`, `LoanState`, `SegmentDayResult`, `OperationsDailyReport`, `WeeklyOperationsReport`, `MonthlyOperationsClose`, `DiscoveredMarketNeed`, and `OperationsState`. Add only `operations?: OperationsState` to `GameState`.

```ts
export interface OperationsState {
  rulesetVersion: "operations-v1";
  difficulty: "casual" | "management";
  reputationBps: number;
  departments: Record<DepartmentId, DepartmentState>;
  pricePolicies: Record<string, RoomPricePolicy>;
  offerUpgrades: Record<string, RoomOfferUpgrade>;
  loans: LoanState[];
  discoveredNeeds: DiscoveredMarketNeed[];
  dailyReports: OperationsDailyReport[];
  weeklyReports: WeeklyOperationsReport[];
  monthlyCloses: MonthlyOperationsClose[];
  maximumReputationBps: number;
  unlockedContent: string[];
  timeSpeed: 0 | 1 | 2 | 4;
  lastOfflineCheckpointMs: number | null;
}
```

- [ ] **Step 4: Implement immutable default creation**

Use stable department insertion order, default staffing/budget/training/standard values, zero loans/reports, `timeSpeed: 0`, and no wall-clock access.

- [ ] **Step 5: Run focused tests, Phase 1/2 state tests, and typecheck**

Run: `cd app && npm test -- src/domain/operations/operationsTypes.test.ts src/domain/game/state.test.ts && npm run typecheck`

Expected: PASS with all legacy `createNewGame` fixtures unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/operations app/src/domain/game/state.ts app/src/domain/game/state.test.ts
git commit -m "feat: add operations state contracts"
```

## Task 2: Six Guest Segments, Hard Requirements, Preferences, and Discovery

**Files:**
- Create: `app/src/domain/operations/segmentCatalog.ts`
- Create: `app/src/domain/operations/roomOffer.ts`
- Create: `app/src/domain/operations/matchGuest.ts`
- Create: `app/src/domain/operations/matchGuest.test.ts`

- [ ] **Step 1: Write failing segment and matching tests**

Cover all six catalog entries, stable demand order, family rejection for a one-bed/two-person room, high-net-worth minimum area, business office/quiet preferences, cultural-experience design-gene preference, and explicit lost-booking reason codes.

```ts
expect(matchGuest(FAMILY_SEGMENT, kingOffer)).toMatchObject({
  eligible: false,
  hardFailure: "requires-family-capacity",
});
expect(matchGuest(BUSINESS_SEGMENT, businessOffer)).toMatchObject({
  eligible: true,
  preferenceScoreBps: 8_000,
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/matchGuest.test.ts`

Expected: FAIL on missing modules.

- [ ] **Step 3: Implement the immutable segment catalog**

Each entry must include display name, base daily demand, hard requirements, price sensitivity, preference weights, and initially hidden need labels. Catalog data contains no functions and can later move to content JSON.

- [ ] **Step 4: Project placed rooms into stable offers**

Resolve Phase 2 `floorPlacements` to variants when present and fall back to the legacy blueprint. Derive `bedType`, `capacity`, `areaSquareMeters`, `viewBps`, `workspaceBps`, `privacyBps`, and design affinities without reading UI or visual assets.

- [ ] **Step 5: Implement matching and reason templates**

Check hard requirements first. For eligible offers, compute weighted preference basis points with integer arithmetic and return the top positive/negative factors. Map reason codes to deterministic Chinese text separately from numeric scoring.

- [ ] **Step 6: Verify focused tests and typecheck**

Run: `cd app && npm test -- src/domain/operations/matchGuest.test.ts && npm run typecheck`

Expected: PASS for every segment and no domain import from React/Tauri.

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/operations
git commit -m "feat: add guest segment matching"
```

## Task 3: Explainable Pricing Policies and Manual Locks

**Files:**
- Create: `app/src/domain/operations/pricing.ts`
- Create: `app/src/domain/operations/pricing.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write failing pricing tests**

Test integer base/min/max validation, manual lock, seasonal demand, trailing occupancy, segment demand, reputation, remaining-inventory adjustments, range clamping, stable explanation factors, and rejection without save mutation. Use a deterministic four-season calendar derived from the integer game day; never read the wall clock.

```ts
expect(suggestRate(policy, context)).toEqual({
  rateCents: 92_000,
  reasons: ["高需求推高建议价", "剩余房量充足抑制涨幅"],
});
expect(suggestRate({ ...policy, locked: true }, context).rateCents)
  .toBe(policy.baseRateCents);
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/pricing.test.ts src/application/gameCommands.test.ts`

Expected: FAIL because pricing policies and commands are absent.

- [ ] **Step 3: Implement pure pricing functions**

Use only integer cents/basis points. `PricingContext` includes `season`, trailing seven-day `occupancyBps`, segment demand, reputation, and remaining inventory. Export `validatePricePolicy`, `suggestRate`, and `effectiveRate`. Never mutate a policy or context.

- [ ] **Step 4: Add atomic commands**

Add `initializeOperations`, `setRoomPricePolicy`, and `setAutomaticPricing` to `createGameCommands`. Initialize policies from placed offer IDs and current suggested rates; preserve Phase 1 `rateCents` as the legacy default policy.

- [ ] **Step 5: Verify RED -> GREEN and legacy rate behavior**

Run: `cd app && npm test -- src/domain/operations/pricing.test.ts src/application/gameCommands.test.ts src/domain/simulation/settleDay.test.ts && npm run typecheck`

Expected: PASS; existing Phase 1 two-day fixtures remain byte-for-byte unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/operations/pricing* app/src/application/gameCommands*
git commit -m "feat: add explainable room pricing"
```

## Task 4: Departments, Leaders, Training, Budget, and Service Capacity

**Files:**
- Create: `app/src/domain/operations/departmentCatalog.ts`
- Create: `app/src/domain/operations/serviceCapacity.ts`
- Create: `app/src/domain/operations/serviceCapacity.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write failing department tests**

Test all six departments, approved leader specialties, staffing/training/budget/standard bounds, deterministic payroll, capacity bottlenecks, and readable effects such as cleaning delay or check-in wait.

```ts
expect(calculateServiceCapacity(departments, occupiedRooms)).toMatchObject({
  overallBps: 7_250,
  bottlenecks: [{ departmentId: "housekeeping", reason: "清扫能力不足" }],
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/serviceCapacity.test.ts src/application/gameCommands.test.ts`

- [ ] **Step 3: Implement aggregate service rules**

Calculate capacity and daily cost from headcount, training, budget, service standard, leader specialty, occupied rooms, and available rooms. Keep morale as an aggregate derived indicator, not an individual simulation.

- [ ] **Step 4: Add update command with affordability rules**

Add `configureDepartment`. Validate all values before persistence. In casual mode an unaffordable budget change remains configurable but the next settlement can use the safety loan; in management mode reject immediate one-time training costs when cash is insufficient.

- [ ] **Step 5: Run focused and regression tests**

Run: `cd app && npm test -- src/domain/operations/serviceCapacity.test.ts src/application/gameCommands.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/operations app/src/application/gameCommands*
git commit -m "feat: add department service management"
```

## Task 5: Deterministic Multi-Segment Daily Settlement

**Files:**
- Create: `app/src/domain/operations/settleOperationsDay.ts`
- Create: `app/src/domain/operations/settleOperationsDay.test.ts`
- Create: `app/src/domain/operations/operationsFixtures.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/domain/simulation/settleDay.ts`

- [ ] **Step 1: Write the approved 30-day replay test first**

Build one fixed hotel fixture and assert that two independent 30-day runs have identical reports, cash, reputation, loans, discovered needs, segment mix, and reason ordering. Add focused cases for hard-requirement loss, price loss, service loss, review generation, room allocation stability, and input immutability.

```ts
const first = replayOperationsDays(fixture, 30);
const second = replayOperationsDays(structuredClone(fixture), 30);
expect(second).toEqual(first);
expect(first.dailyReports).toHaveLength(30);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/settleOperationsDay.test.ts`

Expected: FAIL because the Phase 3 engine is missing.

- [ ] **Step 3: Implement stable demand and allocation**

For each day, derive integer segment demand from the catalog and a documented 7-day pattern. Sort booking candidates by eligibility, match score, effective price fit, stable segment order, then room ID. Never use object iteration order as a hidden tie-breaker.

- [ ] **Step 4: Settle service, finance, reviews, reputation, and discovery**

Produce room revenue, department cost, loan interest, net income, ending cash, segment outcomes, lost-booking reasons, templated reviews, reputation delta, and newly discovered needs. Clamp reputation to 0..10,000.

- [ ] **Step 5: Preserve the legacy settlement entry point**

Keep `settleDay` unchanged for saves without `operations`. The application command dispatches to the Phase 3 engine only after operations initialization.

- [ ] **Step 6: Add atomic one-day command integration**

Update `advanceDay` to persist the rich report and a compatible legacy `DailyReport` projection in one commit. A failed settlement must not partially append either report.

- [ ] **Step 7: Run 30-day, Phase 1, command, and type tests**

Run: `cd app && npm test -- src/domain/operations/settleOperationsDay.test.ts src/domain/simulation/settleDay.test.ts src/application/gameCommands.test.ts && npm run typecheck`

Expected: PASS and the existing Phase 1 day-one/day-two values remain unchanged.

- [ ] **Step 8: Commit**

```bash
git add app/src/domain/operations app/src/domain/simulation/settleDay.ts app/src/application/gameCommands.ts
git commit -m "feat: add deterministic hotel operations"
```

## Task 6: Loans, Difficulty Boundaries, Reputation, and Soft Unlocks

**Files:**
- Create: `app/src/domain/operations/finance.ts`
- Create: `app/src/domain/operations/finance.test.ts`
- Create: `app/src/domain/operations/unlocks.ts`
- Create: `app/src/domain/operations/unlocks.test.ts`
- Modify: `app/src/application/gameCommands.ts`

- [ ] **Step 1: Write failing finance and difficulty tests**

Cover voluntary loan validation, deterministic interest/principal, casual safety-loan injection before cash would go negative, management-mode affordability rejection, reputation thresholds, and unlock permanence after reputation later falls.

```ts
expect(coverCasualShortfall(10_000, 25_000)).toMatchObject({
  borrowedCents: 15_000,
  endingCashCents: 0,
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/finance.test.ts src/domain/operations/unlocks.test.ts`

- [ ] **Step 3: Implement finance and unlock projections**

Use integer cents and explicit loan IDs. Update the persisted `maximumReputationBps` monotonically and union earned content keys into `unlockedContent`; unlocks survive reputation decline and reload.

- [ ] **Step 4: Add `takeLoan`, `repayLoan`, and `setDifficulty` commands**

Allow difficulty changes between settlements. Validate a repayment against cash and outstanding principal before persistence.

- [ ] **Step 5: Integrate loan settlement and verify no negative casual cash**

Run: `cd app && npm test -- src/domain/operations/finance.test.ts src/domain/operations/unlocks.test.ts src/domain/operations/settleOperationsDay.test.ts src/application/gameCommands.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/operations app/src/application/gameCommands.ts
git commit -m "feat: add operations finance and reputation"
```

## Task 7: Daily, Weekly, Monthly, Speed, and Offline Catch-Up

**Files:**
- Create: `app/src/domain/operations/reporting.ts`
- Create: `app/src/domain/operations/reporting.test.ts`
- Create: `app/src/domain/operations/offlineSettlement.ts`
- Create: `app/src/domain/operations/offlineSettlement.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/state/GameProvider.tsx`
- Create: `app/src/state/useOperationsClock.ts`
- Create: `app/src/state/useOperationsClock.test.tsx`

- [ ] **Step 1: Write failing reporting and offline tests**

Assert daily summary every day, one weekly report at days 7/14/21/28, one monthly close at day 30, exact aggregate totals, pause/1x/2x/4x validation, fake-timer advancement at each speed, no advancement while paused, zero-day offline result, seven-day cap, startup elapsed calculation, checkpoint update, deterministic equivalence between batch and repeated daily settlement, and a live timer advance followed by reload that does not settle the same elapsed interval twice.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/reporting.test.ts src/domain/operations/offlineSettlement.test.ts`

- [ ] **Step 3: Implement pure aggregation**

Weekly and monthly reports aggregate already-computed daily reports and never recalculate bookings. Include top result, top reason, and suggested action codes.

- [ ] **Step 4: Implement capped offline calculation**

Export `offlineDaysForElapsed(elapsedMs, millisecondsPerGameDay)` and `settleOfflineDays(state, requestedDays)`. Reject negative/non-finite elapsed values and cap at seven days.

- [ ] **Step 5: Add commands and provider exposure**

Add `setTimeSpeed`, `advanceOperationsDays`, `settleOffline`, and `checkpointOfflineTime`. Every live, manual, batch, and offline advancement receives an application-supplied `nowMs` and moves `lastOfflineCheckpointMs` in the same persisted commit as its reports and cash, so reload cannot double-settle elapsed time. The provider serializes them through the existing command queue. `useOperationsClock` owns the application timer, converts 1x/2x/4x into documented real-time intervals, dispatches one serialized day with the current injected application time at each interval, and is verified with fake timers; no timer or wall-clock read enters domain code. During provider initialization, the application receives an injectable `nowMs`, computes elapsed time from `lastOfflineCheckpointMs`, settles at most seven offline days, then atomically stores the new checkpoint before exposing the loaded state. Visibility suspension also checkpoints through the same serialized command.

- [ ] **Step 6: Verify 30-day report boundaries and compatibility**

Run: `cd app && npm test -- src/domain/operations/reporting.test.ts src/domain/operations/offlineSettlement.test.ts src/domain/operations/settleOperationsDay.test.ts src/application/gameCommands.test.ts && npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add app/src/domain/operations app/src/application/gameCommands.ts app/src/state/GameProvider.tsx
git commit -m "feat: add operations time and reports"
```

## Task 8: Renovation and Explainable Room-Offer Changes

**Files:**
- Create: `app/src/domain/operations/renovation.ts`
- Create: `app/src/domain/operations/renovation.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/application/gameCommands.test.ts`

- [ ] **Step 1: Write failing renovation tests**

Cover a controlled room-offer upgrade (`workspace`, `view`, `familyCapacity`, or `privacy`), deterministic renovation cost, management-mode affordability rejection, casual safety-loan handling, invalid downgrade rejection, construction closure days, and before/after guest-fit explanations.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/domain/operations/renovation.test.ts src/application/gameCommands.test.ts`

- [ ] **Step 3: Implement operations-owned room upgrades**

Persist an `offerUpgrades` record keyed by stable offer ID in `OperationsState`. Project upgrades on top of the Phase 2 room offer; never mutate the saved design cells or AI visuals. Cost and closure duration are fixed content rules, and the preview returns affected segment scores and reasons before commitment.

- [ ] **Step 4: Add preview and commit commands**

Add `previewRoomRenovation` as a pure application projection and `renovateRoomOffer` as an atomic command. Deduct cash or add a casual safety loan, record closure days, and invalidate only reports not yet settled (never rewrite history).

- [ ] **Step 5: Verify settlement effects**

Run: `cd app && npm test -- src/domain/operations/renovation.test.ts src/domain/operations/matchGuest.test.ts src/domain/operations/settleOperationsDay.test.ts src/application/gameCommands.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add app/src/domain/operations/renovation* app/src/application/gameCommands*
git commit -m "feat: add explainable room renovation"
```

## Task 9: Rust and Browser Persistence Validation

**Files:**
- Modify: `app/src-tauri/src/persistence.rs`
- Modify: `app/src/infrastructure/browser/validateBrowserGameState.ts`
- Create: `app/src/infrastructure/browser/validateOperationsState.test.ts`

- [ ] **Step 1: Write failing native and browser malformed-state tests**

Test a legal Phase 3 30-day round-trip plus rejection of unknown segment/department/difficulty, duplicate report days, invalid week/month boundaries, unsafe money/basis points, report totals inconsistent with daily entries, invalid loans, malformed `offerUpgrades`, negative or inconsistent renovation closure days, `maximumReputationBps` below current reputation, duplicate/unknown `unlockedContent`, invalid checkpoint values/order, and more than seven offline-settlement days.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/infrastructure/browser/validateOperationsState.test.ts`

Run: `cd app/src-tauri && cargo test operations -- --nocapture`

Expected: legal snapshots may round-trip through JSON storage, but malformed Phase 3 structures are incorrectly accepted.

- [ ] **Step 3: Add strict optional-envelope validation in both adapters**

Keep `operations` optional. Validate structure and cross-field invariants only; do not duplicate settlement calculations in Rust or browser persistence.

- [ ] **Step 4: Run full persistence gates**

Run: `cd app && npm test -- src/infrastructure/browser && npm run typecheck`

Run: `cd app/src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings && cargo fmt -- --check`

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/persistence.rs app/src/infrastructure/browser
git commit -m "feat: persist phase three operations"
```

## Task 10: Operations Center UI in Result -> Reason -> Action Order

**Files:**
- Modify: `app/src/pages/OperationsPage.tsx`
- Create: `app/src/components/operations/OperationsSummary.tsx`
- Create: `app/src/components/operations/SegmentPerformance.tsx`
- Create: `app/src/components/operations/PricingPanel.tsx`
- Create: `app/src/components/operations/DepartmentPanel.tsx`
- Create: `app/src/components/operations/FinancePanel.tsx`
- Create: `app/src/components/operations/ReportTimeline.tsx`
- Create: `app/src/pages/Phase3OperationsRegression.test.tsx`
- Modify: `app/src/styles.css`

- [ ] **Step 1: Write failing UI tests**

Test the default casual initialization, headline occupancy/ADR/revenue/net/reputation/cash/debt, ordered reason cards, actionable seasonal/occupancy-aware price controls, department leader assignment and reload, staffing/training/budget/standards, room renovation preview/commit, hard-requirement lost reasons, discovered needs, daily/weekly/monthly timeline, difficulty control, working pause/1x/2x/4x, offline-catch-up notice, and readable command errors.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `cd app && npm test -- src/pages/Phase3OperationsRegression.test.tsx`

- [ ] **Step 3: Implement operations initialization and summary**

For a ready/open Phase 2 hotel with no operations envelope, show a single `启用完整经营` action. After initialization, render result metrics first, reasons second, and suggested action controls third.

- [ ] **Step 4: Implement pricing, segments, departments, finance, and reports as projections**

Components receive already-calculated state and dispatch commands. They must not import settlement functions. Use Chinese labels and the existing restrained green/gold visual language.

- [ ] **Step 5: Add time controls without test-time waiting**

Render pause/1x/2x/4x state and an explicit `推进一天` action. Mount `useOperationsClock` so an open hotel actually advances at each nonzero speed; component tests use fake timers and never wait in real time.

- [ ] **Step 6: Run UI, Phase 1/2 regressions, typecheck, and build**

Run: `cd app && npm test -- src/pages/Phase3OperationsRegression.test.tsx src/pages/Phase1Regression.test.tsx src/pages/Phase2DesignRegression.test.tsx src/pages/Phase2FloorRegression.test.tsx && npm run typecheck && npm run build`

- [ ] **Step 7: Commit**

```bash
git add app/src/pages/OperationsPage.tsx app/src/pages/Phase3OperationsRegression.test.tsx app/src/components/operations app/src/styles.css
git commit -m "feat: add operations center UI"
```

## Task 11: Browser Closed Loop, 30-Day Acceptance, and Desktop Smoke

**Files:**
- Create: `app/e2e/phase3-operations.spec.ts`
- Modify: `app/e2e/core-loop.spec.ts`
- Create: `docs/testing/phase-3-desktop-smoke.md`

- [ ] **Step 1: Write the failing browser flow**

Create/load a hotel, initialize casual operations, inspect six segments, change one season/occupancy-aware price policy, assign a housekeeping leader and increase capacity, preview and commit one workspace renovation, verify the business fit/reason changes, use 4x with a test-configured short application interval to advance a day, simulate an offline checkpoint and verify capped catch-up on reload, settle seven days and see a weekly report, settle through day 30 and see the monthly close, reload, and verify cash/reputation/debt/unlocks/leader/renovation/report counts and offline checkpoint restore.

- [ ] **Step 2: Run the new E2E and confirm RED**

Run: `cd app && npm run test:e2e -- e2e/phase3-operations.spec.ts`

Expected: FAIL until all operations selectors and persistence glue are present.

- [ ] **Step 3: Add only necessary selectors and glue**

Use accessible roles/names. Do not expose hidden numeric implementation details solely for tests; visible report values are the acceptance surface.

- [ ] **Step 4: Run all browser tests and the 30-day domain replay**

Run: `cd app && npm run test:e2e && npm test -- src/domain/operations/settleOperationsDay.test.ts`

- [ ] **Step 5: Build the debug macOS application and DMG**

Run: `cd app && npm run tauri -- build --debug`

Record macOS version, architecture, commit, `.app` path, DMG path, operations initialization, one-day settlement, seven-day report, 30-day report, quit/reopen restoration, and visual-provider-offline behavior in the smoke document.

- [ ] **Step 6: Commit**

```bash
git add app/e2e docs/testing/phase-3-desktop-smoke.md
git commit -m "test: verify phase three operations loop"
```

## Task 12: Final Review, Merge, and Phase Gate

- [ ] Run `cd app && npm ci` only after all agents and npm processes stop.
- [ ] Run `npm run typecheck`, all Vitest tests, Vite build, all Playwright tests, all Rust tests, Clippy with warnings denied, rustfmt, and repository `git diff --check`.
- [ ] Dispatch independent specification and code-quality reviews against the Phase 3 plan and resolve every Critical/Important finding with RED -> GREEN tests.
- [ ] Rebuild the macOS `.app` and DMG after the final fix.
- [ ] Commit final review fixes and fast-forward merge the Phase 3 branch to `main` only after fresh verification.
- [ ] Preserve root `.DS_Store` and `初步设想.md`; clean only the owned Phase 3 worktree and branch.
- [ ] Record the Phase 3 exit summary and automatically begin the Phase 4 detailed plan if no product-direction decision is required.

## Plan Self-Review

- Every Phase 3 roadmap item is assigned: segments (Task 2), seasonal/occupancy-aware pricing (Task 3), departments/service/leaders (Task 4), deterministic settlement (Task 5), loans/reputation/persisted unlocks/difficulty (Task 6), functional speed/reports/startup offline catch-up (Task 7), renovation and room-change causality (Task 8), persistence (Task 9), operations center (Task 10), and 30-day acceptance (Task 11).
- The plan does not introduce AI dependencies, individual staff schedules, multiple hotels, public-space operations, random events, or Phase 4 content.
- Phase 1/2 compatibility is explicitly checked in Tasks 1, 3, 5, 8, 9, and 11.
- New gameplay functions are test-first, deterministic, integer-based, and isolated from React/Tauri/SQLite.
