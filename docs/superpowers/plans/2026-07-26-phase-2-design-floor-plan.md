# Phase 2 Design and Floor Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable room-series variants, full editing primitives, template-based ring-corridor floors, selective master synchronization, and durable saves while keeping Phase 1 economics unchanged.

**Architecture:** Pure TypeScript domain modules define transforms, genes, variants, sync previews, and corridor templates. React pages render projections and dispatch commands through the existing GameProvider. SQLite stores versioned JSON snapshots behind the existing SavePort; visual generation remains an isolated provider and cannot alter economics.

**Tech Stack:** Existing Tauri 2, React, TypeScript, Vite, PixiJS, Vitest, Testing Library, Playwright, Rust rusqlite/serde_json.

---

## Shared Fixtures and Constraints

- Preserve Phase 1 save compatibility and deterministic economics.
- Keep domain imports free of React, Tauri, SQLite, PixiJS, and provider code.
- Use the existing 8x12 cell grid; transforms must normalize coordinates and preserve zone/opening metadata.
- Use integer cents/basis points and deterministic IDs in tests.
- No network calls in tests. Visual providers return namespaced asset metadata only.

### Task 1: Freeze Phase 2 Domain Types and Migration Envelope

**Files:**
- Create: `app/src/domain/design/designTypes.ts`
- Create: `app/src/domain/design/stylePresets.ts`
- Modify: `app/src/domain/game/state.ts`
- Create: `app/src/domain/design/designTypes.test.ts`

- [ ] Write failing tests for design genes, three presets, variant fields, and backward-compatible Phase 1 state defaults.
- [ ] Run `cd app && npm test -- src/domain/design/designTypes.test.ts`; confirm missing module or expected failures.
- [ ] Implement the types and immutable preset constants; add optional Phase 2 fields to the authoritative state without changing Phase 1 projections.
- [ ] Run focused tests and `npm run typecheck`.
- [ ] Commit `feat: add phase two design contracts`.

### Task 2: Room Editing Primitives, Openings, Undo/Redo, and Transforms

**Files:**
- Create: `app/src/domain/room/editRoom.ts`
- Create: `app/src/domain/room/transformRoom.ts`
- Create: `app/src/domain/room/editRoom.test.ts`

- [ ] Write failing tests for walls, doors, windows, selection bounds, rotate 90/180/270, mirror, constrained resize, and undo/redo history.
- [ ] Run focused tests and observe RED.
- [ ] Implement pure immutable commands using existing grid validation and normalization; reject openings outside boundaries and disconnected required zones.
- [ ] Run focused tests, existing grid/evaluation tests, and typecheck.
- [ ] Commit `feat: add room editing and transforms`.

### Task 3: Room Master, Variants, Inheritance, and Selective Sync

**Files:**
- Create: `app/src/domain/design/roomSeries.ts`
- Create: `app/src/domain/design/roomSeries.test.ts`
- Modify: `app/src/application/gameCommands.ts`
- Modify: `app/src/domain/game/state.ts`

- [ ] Write failing tests for creating a master, creating bed/twin/corner variants, override tracking, sync previews, select-all/select-none, and preserving unselected overrides.
- [ ] Run focused tests and observe RED.
- [ ] Implement deterministic series commands and sync application; recompute area/cost/rate metrics from each transformed footprint.
- [ ] Run focused command/domain tests and verify Phase 1 settlement fixtures remain unchanged.
- [ ] Commit `feat: add inherited room variants`.

### Task 4: Ring-Corridor Floor Templates and Hints

**Files:**
- Create: `app/src/domain/floor/corridorTemplate.ts`
- Create: `app/src/domain/floor/corridorTemplate.test.ts`
- Modify: `app/src/domain/floor/planFloor.ts`

- [ ] Write failing tests for complete and partial ring templates, core/entrance connectivity, slot dimensions, true-size footprints, service-distance hints, and congestion hints.
- [ ] Run focused tests and observe RED.
- [ ] Implement template generation and deterministic path-distance calculations; keep hints advisory and economics-neutral.
- [ ] Run focused floor tests and existing placement tests.
- [ ] Commit `feat: add ring corridor floor templates`.

### Task 5: Versioned Persistence for Phase 2 Designs

**Files:**
- Modify: `app/src-tauri/migrations/001_initial.sql`
- Modify: `app/src-tauri/src/persistence.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Create or modify: `app/src-tauri/src/persistence_phase2_tests.rs` only if the current module split requires it

- [ ] Write failing Rust tests for migration from Phase 1 snapshots, malformed variant/template rejection, selective sync persistence, revision conflicts, and visual metadata without Base64/secrets.
- [ ] Run the focused Rust tests and observe RED.
- [ ] Add a versioned JSON envelope or normalized tables with strict validation while preserving old `schemaVersion: 1` loads.
- [ ] Run all Rust tests, Clippy with warnings denied, and rustfmt.
- [ ] Commit `feat: persist phase two design state`.

### Task 6: Editor and Variant Filmstrip UI

**Files:**
- Modify: `app/src/pages/RoomDesignPage.tsx`
- Create: `app/src/pages/RoomVariantPage.tsx`
- Create: `app/src/components/design/RoomToolRail.tsx`
- Create: `app/src/components/design/RoomPropertyPanel.tsx`
- Create: `app/src/components/design/VariantFilmstrip.tsx`
- Modify: `app/src/state/GameProvider.tsx`
- Create: `app/src/pages/Phase2DesignRegression.test.tsx`

- [ ] Write failing Testing Library tests for the approved A layout: large center grid, Chinese tool rail, selected-object panel, variant thumbnails, undo/redo, style preset selection, and readable validation errors.
- [ ] Run focused UI tests and observe RED.
- [ ] Implement the minimal three-column layout and filmstrip; keep all economic calculations in domain commands.
- [ ] Run focused UI tests, Phase 1 UI tests, typecheck, and build.
- [ ] Commit `feat: add phase two room editor UI`.

### Task 7: Floor Template and Variant Placement UI

**Files:**
- Modify: `app/src/pages/FloorPlanningPage.tsx`
- Create: `app/src/components/floor/FloorTemplatePicker.tsx`
- Create: `app/src/components/floor/FloorOverview.tsx`
- Create: `app/src/components/floor/FloorHintPanel.tsx`
- Create: `app/src/pages/Phase2FloorRegression.test.tsx`

- [ ] Write failing UI tests for template selection, variant replacement, rotate/mirror controls, true-size thumbnails, corridor/core rendering, and advisory hint states.
- [ ] Run focused tests and observe RED.
- [ ] Implement the approved template-driven layout without exposing free corridor drawing yet.
- [ ] Run focused UI tests, Phase 1 tests, and build.
- [ ] Commit `feat: add ring corridor floor planning UI`.

### Task 8: Isolated Visual Queue and Style Preview

**Files:**
- Modify: `app/src/application/ports/VisualProvider.ts`
- Create: `app/src/application/designVisualQueue.ts`
- Create: `app/src/application/designVisualQueue.test.ts`
- Modify: `app/src/state/GameProvider.tsx`
- Modify: `app/src/pages/RoomVariantPage.tsx`

- [ ] Write failing tests for master image plus 1-3 focus images, queued status, retryable provider errors, asset namespace validation, and unchanged economics.
- [ ] Run focused tests and observe RED.
- [ ] Implement a deterministic local queue adapter with bounded concurrency and explicit visual-only state.
- [ ] Run focused tests and verify visual failures never block save, placement, or settlement.
- [ ] Commit `feat: add phase two visual queue contract`.

### Task 9: Browser Closed Loop and Desktop Smoke

**Files:**
- Modify: `app/e2e/core-loop.spec.ts`
- Create: `app/e2e/phase2-design-floor.spec.ts`
- Modify: `docs/testing/phase-1-desktop-smoke.md`
- Create: `docs/testing/phase-2-desktop-smoke.md`

- [ ] Write the failing Playwright flow: preset -> master -> variants -> selective sync -> ring template -> true-size placement -> save/reload.
- [ ] Run the new E2E and observe RED.
- [ ] Implement only the selectors and glue required by the approved UI, then run the flow to GREEN.
- [ ] Build the debug `.app`/DMG and run the macOS smoke checklist; record commit, OS, architecture, and results.
- [ ] Commit `test: verify phase two design floor slice`.

### Task 10: Final Review, Merge, and Phase Gate

- [ ] Run npm ci, typecheck, all Vitest tests, Vite build, all Playwright tests, all Rust tests, Clippy, rustfmt, and `git diff --check` from a clean checkout.
- [ ] Dispatch spec-compliance and code-quality reviews; resolve all Critical/Important findings.
- [ ] Fast-forward merge the Phase 2 branch to `main` only after fresh verification.
- [ ] Preserve user-owned untracked files and clean only the Phase 2 worktree/branch.
- [ ] Record the Phase 2 exit-gate summary and automatically begin Phase 3 if no product-direction decision is required.
