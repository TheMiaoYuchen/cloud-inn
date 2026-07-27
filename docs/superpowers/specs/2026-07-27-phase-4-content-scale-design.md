# Cloud Inn Phase 4 Content and Scale Design

**Status:** Ready for implementation planning  
**Approved product sources:** `2026-07-25-cloud-inn-design.md` and `2026-07-25-cloud-inn-roadmap.md`  
**Starting point:** Phase 3 merged at `4941858b034305220172ac64f993428604f6e891`

## 1. Outcome

Phase 4 turns the current single-floor operations slice into the first complete tower hotel. A player can view and expand a vertical hotel, operate at least 120 true inventory rooms across multiple guest floors, design and place the approved public-space catalog, configure light facility operations, view aggregate pixel flows, and use content/design/market compendia. The same hotel must settle 30 deterministic days, save, reopen, and remain responsive at the maximum planned density.

Phase 4 remains local and deterministic. It does not add API Nebula credentials, live model calls, keychain storage, export/import, rotating backups, signing, or network recovery; those are Phase 5 reliability and release work.

## 2. Delivery Strategy

Three approaches were evaluated:

1. **Extend the prototype fields in place.** This looks fast but keeps the single `prototype-floor`, one-blueprint tables, and eight-slot assumptions inside every new feature. It is rejected because it makes 100-room persistence and compatibility fragile.
2. **Replace the save model immediately.** This creates the cleanest end state but forces a risky all-at-once rewrite of Phase 1-3 behavior. It is rejected because it weakens regression confidence.
3. **Add an optional authoritative content-scale envelope with deterministic legacy projection.** Existing saves retain their Phase 1-3 fields; Phase 4 games add `phase4`, which becomes authoritative for building, inventory, facilities, catalogs, and flows. A one-way, idempotent upgrade projects the current prototype hotel into the new structure. This is the selected approach.

The implementation proceeds vertically: contracts and compatibility first, then building/inventory, shared public-space design, facility operations, UI, compendia, aggregate flows, and finally scale acceptance.

## 3. Scope Boundaries

### Included

- One high-rise flagship hotel with ground entrance, sky lobby, guest floors, facility floors, service floors, and controlled expansion.
- At least 120 real room instances over 12-16 hotel floors, using stable floor and room IDs.
- Twelve public-space types: sky lobby, all-day dining, Chinese restaurant, bar, executive lounge, spa, pool, gym, ballroom, meeting room, garden terrace, and boutique.
- A shared grid/editor domain for rooms and public spaces, with space-specific zones, items, costs, and validation.
- Facility boosts and light restaurant, bar, spa, and banquet operations.
- Menu structure and a small signature-dish catalog; no ingredient inventory.
- Aggregate pixel guest, staff, luggage, cleaning, and room-service flow visualization.
- A content catalog, design-series library, and discovered-market compendium.
- Deterministic mixed room/facility settlement and explainable reports.
- Browser and macOS persistence validation for the new envelope.

### Deferred

- Individual people, schedules, pathfinding histories, employee stories, or per-guest AI.
- Ingredient purchasing, spoilage, recipes by component, or supplier simulation.
- A large event, award, story, city, branch, account, cloud, or multiplayer system.
- Live image generation, API token setup, primary/fallback networking, image transaction recovery, backups, export/import, signing, or notarization.
- Freely drawing the tower exterior or playing a standalone resort.

## 4. Authoritative Data Model

`GameState` gains an optional `phase4: ContentScaleState`. Its main sections are:

- `building`: building template, purchased hotel floors, expansion offers, entrance and sky-lobby relationships.
- `floorTemplates`: reusable guest and facility floor definitions.
- `floors`: stable floor IDs, floor number, use, template source, room instances, and public-space instances.
- `spaceBlueprints`: public-space designs built with the shared editor.
- `facilities`: operating policies, menus, signature dishes, capacity, current closure, and enabled state.
- `catalogProgress`: unlocked items/facilities/styles and discovered market entries.
- `recentFlowSnapshot`: bounded, derived visual events for the visible hotel state.

Stable IDs never depend on array position. A room ID contains its floor identity and local placement identity; a public-space instance similarly contains floor and local placement identity. Catalog entries are immutable, versioned static content and are referenced by stable IDs rather than copied into each save.

When `phase4` exists, all room inventory and facility projections use it. Legacy `floor`, `roomBlueprint`, and `phase2` remain compatibility inputs and are not continuously double-written at 120-room scale. `upgradeLegacyToPhase4()` is pure, deterministic, idempotent, and does not charge cash or change historic reports.

## 5. Building and Floor Model

The first tower template has a ground entrance and a block of hotel-controlled upper floors. The starting Phase 4 conversion creates:

- a ground entrance/background marker;
- one sky-lobby floor;
- a reusable standard guest-floor template based on the approved central core and ring corridor;
- enough guest floors and room placements to demonstrate scale without granting all expansion for free;
- facility-floor slots that can be purchased and assigned.

Guest-floor templates use true cell dimensions and data-driven slot density, rather than the current fixed eight-slot prototype. Copying a floor creates new instance IDs while preserving template references, room types, rotation, mirroring, and construction cost. Editing the template later does not silently mutate already-built floors; the player receives an explicit preview and chooses which floors to synchronize.

Expansion has a fixed catalog cost, prerequisite, and floor-use constraint. A command validates availability and cash, then atomically records ownership, construction cost, inventory, pricing-policy reconciliation, and facility state.

## 6. Shared Space Editor

The existing room grid operations become a neutral editor core:

- cells carry a space-specific zone ID rather than only bedroom/bathroom;
- shared tools handle rectangle, paint, erase, selection, undo/redo, openings, placed items, rotation, alignment, cost, and connectivity;
- a `SpaceTypeDefinition` provides allowed/required zones, item rules, validation, and operating metrics;
- room-specific behavior remains covered by existing tests and adapters.

Public-space validators are content strategies, not separate editors:

- lobby: entrance, reception, waiting, luggage, and lift-lobby relationship;
- restaurant/bar: seating, kitchen or service point, pass/bar, capacity, and service route;
- pool: water body, deck, wet route, and safety access;
- spa: reception, treatment rooms, wet zone, quietness, and privacy;
- ballroom/meeting: capacity, stage or meeting setup, back-of-house, partitions, and egress;
- other facilities reuse the closest strategy with catalog-specific required zones/items.

The editor calculates construction cost, capacity, service distance, guest appeal, and relevant facility scores with local rules. Visual assets remain optional decoration and never determine these values.

## 7. Content Catalog

Static catalogs define:

- the twelve facility types and their construction/operating ranges;
- shared and facility-specific key items;
- building and floor templates;
- menu formats, price bands, and signature dishes;
- content unlock prerequisites;
- display names, descriptions, icons or pixel tokens, and sorting order.

Catalog functions validate duplicate IDs, illegal references, money ranges, zone compatibility, and deterministic ordering. Saves store only player choices, unlock state, and stable references.

Phase 4 supplies a meaningful but bounded first catalog: all twelve facility types are selectable; the four light-operation groups have 3-5 positioning or service choices; restaurant and bar each have several menu structures and signature choices. Decorative item breadth may grow later, but every required validator has at least one complete playable content path.

## 8. Facility Operations

Facilities fall into two groups:

- **Boost facilities:** lobby, executive lounge, pool, gym, garden terrace, boutique, and non-commercial support spaces primarily affect brand appeal, segment fit, satisfaction, and service capacity.
- **Light-operation facilities:** all-day dining, Chinese restaurant, bar, spa, ballroom, and meeting rooms expose position, price, capacity, opening policy, service budget, and a signature offering where relevant.

The deterministic facility settlement receives day, seed, guest-segment demand, hotel occupancy, facility designs, policies, departments, and reputation. It returns revenue, operating cost, capacity use, satisfaction effects, non-resident demand, reasons, and bounded flow events. It never mutates room demand directly or calls an AI/network adapter.

Restaurant and bar menus choose a structure and price band. Signature dishes have a one-time development cost, per-cover food cost, segment appeal, and reputation contribution. There is no stock count. Spa and banquet products use the same policy shape with service packages rather than dishes.

Daily report v2 separates room revenue, public-space revenue, department cost, facility operating cost, finance cost, and total net income while accepting old reports without Phase 4 fields. Weekly and monthly reports aggregate the same categories. The 30-day Phase 3 acceptance remains supported; Phase 4 scale acceptance runs a fresh 30-day hotel scenario rather than expanding the calendar horizon.

## 9. Application Commands and Atomicity

The Phase 3 command facade is split by responsibility while preserving the single UI queue:

- building commands: initialize scale state, buy/assign a floor, copy/synchronize a floor template;
- space commands: save a public-space blueprint, place or replace a facility;
- facility commands: configure policy, develop/select signature offering, open/close facility;
- content queries: building projection, inventory, catalog, design library, and compendium;
- hotel settlement: compose room operations and facility settlement, then commit finance/reputation/reports once.

Every mutation validates the current revision, clones only the affected envelope, and performs one `SavePort.commit`. Failed persistence leaves the caller state and stored snapshot unchanged. Construction and configuration commands reconcile room pricing, renovation references, facility references, and cash before commit.

## 10. Persistence and Validation

SQLite adds an optional `phase4_json` column through an idempotent migration. Existing normalized prototype tables and JSON envelopes remain loadable. Phase 4 does not attempt the Phase 5 backup/export redesign.

Browser and Rust validators enforce equivalent invariants:

- unique stable IDs and valid cross-references;
- bounded floors, rooms, spaces, cells, items, menus, facilities, and flow events;
- catalog IDs from explicit allowlists/versioned fixtures;
- safe integers for money and counts;
- exact report arithmetic;
- true floor-scoped room uniqueness;
- valid template/instance relationships;
- no raw image data, network credentials, or unbounded prose.

Shared valid/invalid JSON fixtures test both validators. A 120-room, multi-facility save must round-trip through browser storage and SQLite without reordering semantic data, corruption, or loss.

## 11. UI and Navigation

The default hotel overview becomes a vertical tower dashboard. It shows hotel-controlled floors in physical order, floor use, room/facility counts, opening status, an operating summary, and actionable expansion slots. Clicking a floor opens the floor workspace.

The floor workspace keeps the middle canvas dominant, with a collapsible vertical floor rail and inspector. Guest floors show true-size rooms and status overlays; facility floors show true-size public spaces. Only the selected floor mounts its detailed scene.

New routes provide:

- building overview;
- selected-floor planning;
- public-space design;
- facility operations within the result -> reason -> action center;
- content/design/market compendia.

Existing Phase 1-3 routes continue to load legacy saves. Phase 4 pages use plain-language Chinese, accessible controls, deterministic sorting, and no hidden test-only data.

## 12. Aggregate Pixel Flows

Flow visualization is a projection, not a simulation authority. It derives bounded events from the latest bookings, room/facility utilization, department bottlenecks, and visible geometry:

- guest arrival and lift transfer;
- luggage delivery;
- housekeeping and cleaning cart;
- room service;
- facility visitor and staff movement.

The renderer pools sprites, reuses textures, culls off-screen floors, and selects a representative sample. It never stores individual schedules or lets animation timing affect settlement. A saved bounded snapshot may preserve the immediate visual scene, but it can always be regenerated from the saved day, seed, and report.

## 13. Compendia

The content compendium has three player-facing views:

- content catalog: unlocked/locked facilities, items, menus, and their plain-language effects;
- design library: hotel gene, design series, room variants, space blueprints, and their usage across floors;
- market compendium: six guest segments, discovered hard needs/preferences, observed facility interests, and evidence from reports.

These are read-only projections over catalogs and saved progress. They do not duplicate authoritative content or create unlocks merely by opening the page.

## 14. Performance and Density Budgets

The Phase 4 acceptance fixture contains 120 rooms, 12-16 hotel floors, at least six operating public facilities including two restaurants/bar/spa/banquet categories, all six guest segments, and bounded flow visualization.

On the current development Mac:

- one deterministic day settles in at most 100 ms after warm-up;
- a 30-day batch settles in at most 2 seconds;
- saving and loading the maximum fixture each complete in at most 1 second;
- floor selection reacts within 100 ms;
- active floor pan/zoom/render maintains a 30 fps floor (p95 frame no slower than 33 ms);
- the renderer mounts at most 150 animated sprites and no detailed off-screen floor scene;
- additional resident memory for the maximum fixture remains below 200 MB;
- saved Phase 4 JSON and bounded history remain size-limited and validator-safe.

Performance tests use stable fixtures and generous clock isolation so they detect regressions without depending on remote services. Browser E2E proves usability; a debug macOS build and smoke prove WKWebView rendering and native persistence.

## 15. Error Handling

- Invalid placement, expansion, menu, or facility configuration returns a Chinese explanation and does not partially charge cash.
- A missing catalog reference rejects load with a precise compatibility error; it is not silently replaced.
- A public-space validator returns all actionable planning issues, separating blocking errors from advisory hints.
- If flow rendering fails, the hotel remains fully operable and falls back to static occupancy/status overlays.
- Old saves upgrade only after validation; failed upgrade preserves the original stored revision.
- Network status has no effect because Phase 4 performs no required network call.

## 16. Verification and Exit Gate

Every behavior follows RED -> GREEN tests. Required gates are:

- pure domain tests for catalogs, IDs, building/floor operations, space validators, facility settlement, menus, reports, compendia, flows, and performance fixtures;
- command tests for cash, reconciliation, one-commit atomicity, stale revisions, and failed persistence;
- shared browser/Rust persistence fixtures plus legacy Phase 1-3 round-trips;
- component tests for tower overview, floor navigation, editor validation, facility actions, and compendia;
- browser E2E from a legacy hotel through Phase 4 conversion, expansion, facility setup, 30-day operation, reload, and maximum-density navigation;
- full TypeScript, Vitest, Vite, Playwright, Rust, Clippy, rustfmt, and diff checks;
- debug macOS `.app` and DMG build, launch, maximum-density floor navigation, settlement, quit/reopen, and accurate smoke record.

Phase 4 is complete only when the 120-room mixed hotel meets the budgets, neither browser nor native save validation loses data, all Critical/Important reviews are resolved, and Phase 1-3 regression flows remain playable.

## 17. Design Self-Review

- The design covers every Phase 4 roadmap item and the approved public-space rules.
- Phase 5 keychain, API Nebula, recovery, backup, export/import, and release work remain explicitly excluded.
- The authoritative-envelope approach avoids conflicting single-floor/100-room double writes.
- Money, demand, reputation, reports, and unlocks remain deterministic and local.
- Public-space content is broad enough to be playable without introducing ingredient inventory or individual simulation.
- All IDs, limits, compatibility behavior, arithmetic, and performance budgets are explicit; no implementation choice is left as a placeholder.
