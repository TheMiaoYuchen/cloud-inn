# Cloud Inn Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase plan task-by-task. This roadmap defines phase boundaries; each phase gets its own detailed checkbox plan before implementation.

**Goal:** Deliver the approved Cloud Inn macOS game as five playable, independently verifiable phases without coupling core simulation to AI or desktop infrastructure.

**Architecture:** Keep deterministic hotel rules in pure TypeScript, render interaction through React and PixiJS, and place SQLite, filesystem, keychain, and network access behind Tauri adapters. Each phase ends with a playable vertical slice and freezes shared contracts before parallel content work begins.

**Tech Stack:** Tauri 2, React, TypeScript, Vite, PixiJS, SQLite, Vitest, Testing Library, Playwright, Rust stable, npm lockfile, Cargo lockfile.

---

## Delivery Rules

- The repository root owns product documents; the application lives in `app/`.
- A phase starts only after its detailed plan is written and reviewed.
- Domain code cannot import React, PixiJS, Tauri, SQLite, or an AI provider.
- UI code dispatches domain commands and renders domain projections; it does not calculate financial outcomes.
- Tauri commands implement narrow ports owned by the application layer.
- AI results may add image assets and optional prose, but cannot alter room scores, demand, occupancy, cash, or reputation.
- Parallel agents may own separate modules only after shared types and acceptance fixtures are committed.
- Every task follows test-first steps and ends in a focused commit.
- Browser E2E verifies the Vite frontend. Packaged macOS WKWebView behavior requires a separate manual smoke test.

## Phase 0: Environment and Project Foundation

**Outcome:** A Tauri 2 Mac application opens, navigates between a hotel overview and a PixiJS canvas, and has working type, unit, component, browser E2E, Rust, and build checks.

**Includes:**

- Node/npm and Rust toolchain pinning.
- Tauri 2 + React + TypeScript + Vite scaffold in `app/`.
- Hash-based navigation and minimal application shell.
- PixiJS lifecycle boundary with resize and teardown behavior.
- Vitest, Testing Library, and Playwright configuration.
- macOS development and debug-build smoke checklist.

**Excludes:** SQLite, AI, keychain, game entities, design system polish, and production signing.

**Exit gate:** All automated checks pass; the current Mac can launch the development app and debug bundle, navigate, render one Pixi primitive, resize, close, and reopen without duplicate canvases or crashes.

## Phase 1: Core Closed-Loop Prototype

**Outcome:** A player creates one room type on a 0.5-meter grid, places it on one small floor, opens the hotel to one business segment, advances one deterministic day, sees occupancy/revenue/cost/profit, attaches one generated or placeholder room image, and reloads the save.

**Includes:**

- Pure TypeScript room, floor, market, price, and day-settlement contracts.
- Rectangle zoning plus single-cell paint correction for a bedroom and bathroom.
- Minimal cost and business-guest fit calculation.
- One floor with a fixed corridor and repeated room instances.
- One business guest segment and one room price.
- Seeded one-day settlement with an explanation.
- AI image port with a deterministic fake adapter; optional API Nebula adapter only after the fake flow is complete.
- SQLite-backed save/load for the single prototype save.
- One end-to-end flow covering design through reload.

**Excludes:** Full furniture library, doors/windows, free corridor drawing, multiple guests, auto-pricing, departments, loans, background queue, image consistency workflow, backups, and polished building overview.

**Exit gate:** The same seed and inputs produce the same settlement; changing room area or price changes cost or demand in a tested way; AI failure leaves gameplay intact; reopening restores the exact room, floor, price, image metadata, and latest ledger.

## Phase 2: Design and Floor Vertical Slice

**Outcome:** Room and public-space creation feels like the approved editor, and a square tower supports real-size room variants around an editable core and ring corridor.

**Includes:**

- Full grid tools, functional zones, walls, doors, windows, selection, undo/redo, and validation.
- First 40-60 key luxury-hotel items with costs and light experience effects.
- Hotel, series, and room design genes plus reusable style presets.
- Room variants, rotate, mirror, constrained resize, thumbnails, zoom information levels, and floor templates.
- Central core, complete/partial ring corridors, connectivity, entrances, service distance, and congestion hints.
- AI design queue, main visual, 1-3 focus images, reference-image consistency, local redraw, comparison, and version history.

**Exit gate:** A room series can be created, rendered consistently, placed at true scale in different variants around a ring corridor, copied to another floor, validated, saved, and restored.

## Phase 3: Operations Vertical Slice

**Outcome:** The hotel operates as a transparent, low-pressure management game with meaningful room-market fit and controllable service economics.

**Includes:**

- Business, couple, family, leisure, high-net-worth, and cultural-experience segments.
- Hard requirements, weighted preferences, lost-booking reasons, reviews, and market discovery.
- Base prices, allowed ranges, explainable automatic pricing, and manual lock.
- Departments, leaders, staffing aggregates, training, budget, standards, and service capacity.
- Cash, construction, renovation, loans, reputation, and soft unlocks.
- Pause, 1x/2x/4x, daily summary, weekly report, monthly close, and capped offline settlement.
- Casual and management difficulty boundaries.
- Operations center following result -> reason -> action.

**Exit gate:** Thirty seeded game days can be replayed deterministically; guest mix, room changes, prices, and service budgets have explainable effects; neither text AI nor network access is required.

## Phase 4: Content and Scale

**Outcome:** The first tower hotel supports 100+ rooms and a rich set of guest and public spaces while remaining coherent and responsive.

**Includes:**

- Vertical building overview, hotel entrance, sky lobby, guest floors, facility floors, and expansion.
- Sky lobby, all-day dining, Chinese restaurant, bar, executive lounge, spa, pool, gym, ballroom, meeting rooms, garden terrace, and boutique.
- Shared editor core plus space-specific tools and validators.
- Facility boosts and light restaurant/bar/spa/banquet operations.
- Menu structure and signature dishes without ingredient inventory.
- Pixel guest, staff, luggage, cleaning, and room-service flow visualization.
- Content catalog, design series library, and discovered-market compendium.

**Exit gate:** A 100+ room hotel with several public facilities can run for 30 days within the agreed frame-time and memory budgets, with no save corruption and no UI becoming unusable at maximum planned density.

## Phase 5: Reliability and macOS Release

**Outcome:** A recoverable, exportable, secure macOS build is suitable for long-term personal play and later public-release preparation.

**Includes:**

- Transactional image writes and database references.
- Named saves, 20 rotating recovery points, save migrations, and `.cloudinn` export/import validation.
- macOS keychain storage for the API Nebula token and log redaction.
- Offline queue recovery, provider/model checks, primary/fallback behavior, and large-response limits.
- Performance, long-run, crash-recovery, missing-asset, migration, and current-Mac packaging tests.
- Application icon, menus, window behavior, first-run setup, diagnostics, and player-facing error language.
- Signing/notarization readiness assessment; public distribution remains a separate release decision.

**Exit gate:** A packaged app survives forced closure during write tests, restores or rolls back cleanly, exports and reimports a complete hotel, keeps the API token out of saves/logs, and passes a multi-hour current-Mac soak test.

## Future Tracks Outside Version 1

- Standalone resort and city boutique building scenarios.
- Multiple cities, branches, and hotel-group management.
- iCloud synchronization, accounts, community, or multiplayer.
- Full employee schedules and individual simulation.
- Ingredient inventory and per-dish procurement.
- Large award, story, and random-event systems.

These tracks reuse versioned city, hotel instance, brand, and building-type identifiers. They must not add dormant UI or speculative logic to Version 1.
