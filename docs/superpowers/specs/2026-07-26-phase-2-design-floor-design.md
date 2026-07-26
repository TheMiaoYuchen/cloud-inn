# Cloud Inn Phase 2: Design and Floor Vertical Slice

## Goal

Extend the Phase 1 prototype into a coherent room-and-floor editor for a square high-rise hotel: a large pixel-grid canvas, reusable room-series variants, template-based ring corridors, and true-scale floor thumbnails.

## Approved Product Decisions

1. **Room editor layout:** three columns with a dominant center canvas, left construction tools, right selected-object properties, and a bottom filmstrip of room thumbnails/variants.
2. **Floor layout:** template ring corridor around a fixed central core, with replaceable room slots. The first version guarantees connectivity; free corridor drawing remains a later extension.
3. **Room variants:** a hotel-level design gene and series-level master room feed inherited variants. Variants can change bed type, area, view, furniture layout, and feature intensity without losing the shared visual language.
4. **Master synchronization:** master updates show affected variants and properties individually. Players choose which variants receive each update, with select-all/select-none shortcuts. Manually overridden properties remain protected unless explicitly selected.

## Scope

### In scope

- Full 8x12 room-grid tools: paint, erase, rectangle, selection, walls, doors, windows, undo, redo, and validation.
- Room design genes and three starter style presets compatible with the approved luxury direction: contemporary oriental, quiet metropolitan luxury, and natural resort.
- Room series, master blueprint, inherited variants, override tracking, and selective synchronization.
- Variant rotate, mirror, constrained resize, room thumbnail generation, and zoom information levels.
- Floor templates with central core, complete/partial ring corridors, entrances, service-distance and congestion hints.
- True-size placement of different room variants around the corridor, with floor overview thumbnails showing area differences.
- Local deterministic visual queue contract for a master image and 1-3 focus images; network provider remains optional and isolated.
- Save/load migration and browser/desktop acceptance coverage for the new contracts.

### Explicitly out of scope

- A free-form corridor drawing tool.
- The full 40-60 item luxury catalog; Phase 2 uses a small representative starter catalog.
- Multiple hotels, cities, guest segments, departments, or new economic rules.
- Automatic bulk synchronization without an explicit player choice.

## Shared Data Model

The domain remains pure TypeScript. UI sends commands and renders projections. Tauri/SQLite only implement persistence ports.

```ts
type DesignGene = {
  palette: string;
  materials: string[];
  metal: string;
  lighting: string;
  mood: string;
};

type StylePreset = { id: string; name: string; gene: DesignGene };

type RoomVariant = {
  id: string;
  name: string;
  masterId: string;
  cells: Cell[];
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  overrides: Array<"bedType" | "area" | "view" | "furniture" | "featureIntensity" | "gene">;
  gene: DesignGene;
};

type CorridorTemplate = {
  id: string;
  name: string;
  width: number;
  height: number;
  core: Cell[];
  corridor: Cell[];
  entrances: Cell[];
  slots: Array<{ id: string; anchor: { x: number; y: number }; width: number; height: number }>;
};
```

## Interaction Rules

- Every room edit is local draft state until the player saves the blueprint or variant.
- Undo/redo is scoped to the current room draft and never changes authoritative cash or room placement until save.
- A variant can only be resized within its slot and must remain connected, contain required functional zones, and keep doors/windows on valid boundaries.
- Rotate and mirror transform cells and openings deterministically; metrics and construction cost update from the transformed footprint.
- A floor template is valid only when every room slot connects to the ring corridor and at least one entrance connects the corridor to the core/lift lobby.
- Service distance is a transparent hint derived from corridor path length; it never silently changes Phase 1 economics.
- Master synchronization is a previewable command. Only selected variant/property pairs are changed; unselected overrides remain unchanged.
- Visual generation writes namespaced image metadata only. Provider failures are visible and never affect design validity, cost, cash, occupancy, or reports.

## Acceptance Scenarios

1. Draw a room with walls, a door, a window, bedroom and bathroom zones; undo and redo changes; invalid disconnected layouts are rejected with a readable reason.
2. Choose a style preset, save a master room, create large-bed, twin-bed, and corner variants, rotate/mirror one, and see distinct true-size thumbnails.
3. Change the master lighting gene; the sync preview lists all variants, select-all/select-none works, and only selected variants update.
4. Place variants into a ring-corridor floor template; the overview reflects their different footprints and flags service-distance or congestion hints without blocking valid layouts.
5. Close/reopen the packaged app and restore master, variants, template, overrides, thumbnails, and image metadata without storing Base64 image data or secrets.

## Verification

- Vitest domain and command tests for transforms, validation, inheritance, sync selection, template connectivity, service hints, and migration.
- Testing Library coverage for the editor, sync dialog, variant filmstrip, and floor overview.
- Playwright closed loop for create-master -> variants -> selective sync -> template placement -> save/reload.
- Rust persistence tests for transactional migration, revision safety, malformed variant/template rejection, and image metadata isolation.
- Packaged macOS smoke for the editor, ring floor, close/reopen, and local visual failure path.
