import { createOperationsState } from "./createOperationsState";
import type { DepartmentId, OperationsState } from "./operationsTypes";
import type { RoomOffer } from "./roomOffer";

const STAFFING: Readonly<Record<DepartmentId, number>> = Object.freeze({
  frontOffice: 2,
  housekeeping: 2,
  foodAndBeverage: 1,
  engineering: 1,
  security: 1,
  guestRelations: 1,
});

export function createApprovedOperations(): OperationsState {
  const operations = createOperationsState("casual");
  for (const id of Object.keys(STAFFING) as DepartmentId[]) {
    operations.departments[id] = {
      ...operations.departments[id],
      staffing: STAFFING[id],
      dailyBudgetCents: STAFFING[id] * 5_000,
      trainingBps: 5_000,
      serviceStandardBps: 7_000,
    };
  }
  return operations;
}

function affinities(favored: keyof RoomOffer["designAffinities"]): RoomOffer["designAffinities"] {
  return {
    business: favored === "business" ? 9_000 : 5_000,
    couple: favored === "couple" ? 9_000 : 5_000,
    family: favored === "family" ? 9_000 : 5_000,
    leisure: favored === "leisure" ? 9_000 : 5_000,
    "high-net-worth": favored === "high-net-worth" ? 9_000 : 5_000,
    "cultural-experience": favored === "cultural-experience" ? 9_000 : 5_000,
  };
}

export function createApprovedOffers(): RoomOffer[] {
  return [
    { id: "offer:room-01:business", sourceRoomId: "room-01", bedType: "double", capacity: 2, areaSquareMeters: 32, nightlyRateCents: 75_000, viewBps: 5_000, workspaceBps: 9_000, quietBps: 8_000, privacyBps: 6_000, designAffinities: affinities("business") },
    { id: "offer:room-02:couple", sourceRoomId: "room-02", bedType: "king", capacity: 2, areaSquareMeters: 38, nightlyRateCents: 90_000, viewBps: 8_000, workspaceBps: 4_000, quietBps: 7_000, privacyBps: 9_000, designAffinities: affinities("couple") },
    { id: "offer:room-03:family", sourceRoomId: "room-03", bedType: "twin", capacity: 3, areaSquareMeters: 44, nightlyRateCents: 80_000, viewBps: 6_000, workspaceBps: 4_000, quietBps: 7_000, privacyBps: 6_000, designAffinities: affinities("family") },
    { id: "offer:room-04:leisure", sourceRoomId: "room-04", bedType: "double", capacity: 2, areaSquareMeters: 36, nightlyRateCents: 70_000, viewBps: 9_000, workspaceBps: 4_000, quietBps: 7_000, privacyBps: 6_000, designAffinities: affinities("leisure") },
    { id: "offer:room-05:luxury", sourceRoomId: "room-05", bedType: "king", capacity: 2, areaSquareMeters: 60, nightlyRateCents: 180_000, viewBps: 9_000, workspaceBps: 7_000, quietBps: 9_000, privacyBps: 9_000, designAffinities: affinities("high-net-worth") },
    { id: "offer:room-06:culture", sourceRoomId: "room-06", bedType: "double", capacity: 2, areaSquareMeters: 40, nightlyRateCents: 85_000, viewBps: 8_000, workspaceBps: 5_000, quietBps: 7_000, privacyBps: 7_000, designAffinities: affinities("cultural-experience") },
  ];
}

export function createApprovedSettlementInput() {
  return {
    day: 1,
    cashCents: 8_000_000,
    operations: createApprovedOperations(),
    offers: createApprovedOffers(),
  };
}
