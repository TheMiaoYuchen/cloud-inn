import type { StableId } from "../domain/building/buildingTypes";
import { projectContentProgress } from "../domain/content/contentProgress";
import type { DesignGene } from "../domain/design/designTypes";
import { FACILITY_CATALOG } from "../domain/content/contentCatalog";
import type { GameState } from "../domain/game/state";
import type { GuestSegmentId } from "../domain/operations/operationsTypes";
import { GUEST_SEGMENTS } from "../domain/operations/segmentCatalog";

export interface DesignLibraryEntry {
  id: string;
  name: string;
  kind: "room-series" | "room-variant" | "public-space" | "mixed";
  usageFloorIds: readonly StableId[];
}

export interface DesignLibraryProjection {
  hotelGene: Readonly<DesignGene> | null;
  entries: readonly DesignLibraryEntry[];
}

export interface MarketEvidence {
  kind: "segment-result" | "lost-booking" | "review";
  day: number;
  text: string;
}

export interface MarketEntryProjection {
  segmentId: GuestSegmentId;
  name: string;
  discovered: boolean;
  hardNeeds: readonly string[];
  preferences: readonly string[];
  discoveredNeeds: readonly {
    kind: string;
    discoveredDay: number;
    strengthBps: number;
  }[];
  facilityInterests: readonly { type: string; name: string; appealBps: number }[];
  evidence: readonly MarketEvidence[];
}

export interface MarketCompendiumProjection {
  entries: readonly MarketEntryProjection[];
}

function uniqueSortedFloorIds(ids: readonly StableId[]): StableId[] {
  return [...new Set(ids)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function projectDesignLibrary(state: Readonly<GameState>): DesignLibraryProjection {
  if (!state.phase4) return { hotelGene: state.phase2?.hotelGene ?? null, entries: [] };
  const roomUsage = (designId: string) => uniqueSortedFloorIds(state.phase4!.floors
    .filter(({ rooms }) => rooms.some(({ roomBlueprintId, variantId }) =>
      roomBlueprintId === designId || variantId === designId))
    .map(({ id }) => id));
  const publicUsage = (blueprintId: string) => uniqueSortedFloorIds(Object.values(
    state.phase4!.publicSpaces,
  ).filter(({ blueprintId: candidate }) => candidate === blueprintId).map(({ floorId }) => floorId));

  const entries: DesignLibraryEntry[] = [];
  const entryById = new Map<string, DesignLibraryEntry>();
  const addDesign = (
    design: { id: string; name: string },
    kind: Exclude<DesignLibraryEntry["kind"], "mixed">,
    usageFloorIds: readonly StableId[],
  ) => {
    const existing = entryById.get(design.id);
    if (!existing) {
      const entry = { id: design.id, name: design.name, kind, usageFloorIds };
      entryById.set(design.id, entry);
      entries.push(entry);
      return;
    }
    const crossesPublicSpaceBoundary = (existing.kind === "public-space") !== (kind === "public-space")
      || existing.kind === "mixed";
    existing.kind = crossesPublicSpaceBoundary ? "mixed" : existing.kind;
    if (!existing.name.split(" / ").includes(design.name)) {
      existing.name = `${existing.name} / ${design.name}`;
    }
    existing.usageFloorIds = uniqueSortedFloorIds([...existing.usageFloorIds, ...usageFloorIds]);
  };
  const master = state.phase2?.roomMaster;
  if (master) addDesign(master, "room-series", roomUsage(master.id));
  for (const variant of state.phase2?.roomVariants ?? []) {
    addDesign(variant, "room-variant", roomUsage(variant.id));
  }
  if (state.roomBlueprint) {
    addDesign(state.roomBlueprint, "room-series", roomUsage(state.roomBlueprint.id));
  }
  for (const blueprint of Object.values(state.phase4.spaceBlueprints)) {
    addDesign(blueprint, "public-space", publicUsage(blueprint.id));
  }
  return { hotelGene: state.phase2?.hotelGene ?? null, entries };
}

const PREFERENCE_LABELS: Record<string, string> = {
  view: "景观", workspace: "办公", quiet: "安静", privacy: "私密", design: "设计", price: "价格",
};

function hardNeedsFor(segment: Readonly<(typeof GUEST_SEGMENTS)[number]>): string[] {
  const requirements = segment.hardRequirements;
  return [
    ...(requirements.minimumCapacity ? [`至少 ${requirements.minimumCapacity} 人入住`] : []),
    ...(requirements.minimumAreaSquareMeters ? [`客房至少 ${requirements.minimumAreaSquareMeters}㎡`] : []),
    ...(requirements.requiredBedTypes ? [`床型需要 ${requirements.requiredBedTypes.join(" / ")}`] : []),
  ];
}

export function projectMarketCompendium(state: Readonly<GameState>): MarketCompendiumProjection {
  const discoveredIds = new Set(state.phase4?.catalogProgress.discoveredMarketEntryIds ?? []);
  const reports = state.operations?.dailyReports ?? [];
  return {
    entries: GUEST_SEGMENTS.map((segment): MarketEntryProjection => {
      const discovered = discoveredIds.has(`market:${segment.id}` as StableId);
      const discoveredNeeds = (state.operations?.discoveredNeeds ?? [])
        .filter(({ segmentId }) => segmentId === segment.id)
        .map(({ kind, discoveredDay, strengthBps }) => ({ kind, discoveredDay, strengthBps }));
      const hasReportEvidence = reports.some((report) =>
        report.segments.some(({ segmentId }) => segmentId === segment.id)
        || (report.lostBookings ?? []).some(({ segmentId }) => segmentId === segment.id)
        || (report.reviews ?? []).some(({ segmentId }) => segmentId === segment.id));
      const facilityInterests = discovered || discoveredNeeds.length > 0 || hasReportEvidence
        ? FACILITY_CATALOG.map((facility) => {
        const values = Object.values(state.phase4?.facilities ?? {})
          .filter(({ type }) => type === facility.type)
          .map(({ segmentInputs }) => segmentInputs[segment.id]?.appealBps ?? 0);
        return { type: facility.type, name: facility.name, appealBps: Math.max(0, ...values) };
      }).filter(({ appealBps }) => appealBps > 0)
        .sort((left, right) => right.appealBps - left.appealBps)
        .slice(0, 3) : [];
      const evidence = reports.flatMap((report): MarketEvidence[] => {
        const result = report.segments.find(({ segmentId }) => segmentId === segment.id);
        return [
          ...(result ? [{
            kind: "segment-result" as const,
            day: report.day,
            text: `需求 ${result.demand}，售出 ${result.soldRooms}，满意度 ${result.satisfactionBps / 100}%`,
          }] : []),
          ...(report.lostBookings ?? []).filter(({ segmentId }) => segmentId === segment.id)
            .map(({ explanation }) => ({ kind: "lost-booking" as const, day: report.day, text: explanation })),
          ...(report.reviews ?? []).filter(({ segmentId }) => segmentId === segment.id)
            .map(({ text }) => ({ kind: "review" as const, day: report.day, text })),
        ];
      });
      return {
        segmentId: segment.id,
        name: segment.displayName,
        discovered,
        hardNeeds: discovered ? hardNeedsFor(segment) : [],
        preferences: discovered ? Object.entries(segment.preferenceWeights)
          .filter(([, weight]) => weight >= 1_000)
          .sort((left, right) => right[1] - left[1])
          .map(([key, weight]) => `${PREFERENCE_LABELS[key] ?? key} ${weight / 100}%`) : [],
        discoveredNeeds,
        facilityInterests,
        evidence,
      };
    }),
  };
}

export function projectCompendia(state: Readonly<GameState>) {
  return {
    content: projectContentProgress(state),
    design: projectDesignLibrary(state),
    market: projectMarketCompendium(state),
  };
}
