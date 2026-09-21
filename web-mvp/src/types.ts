export type FurnitureSelection = {
  id: string;
  material: string;
  style: string;
};

export type DesignProject = {
  id: string;
  name: string;
  blueprintId?: string;
  designKind: "room" | "zone";
  roomTypeId: string;
  bedTypeId: string;
  furniture: FurnitureSelection[];
  zoneTypeId?: string;
  areaSqm: number;
  stylePrompt: string;
  imageDataUrl?: string;
  updatedAt: string;
};

export type LegendGift = {
  guestName: string;
  guestTitle: string;
  stayStory: string;
  note: string;
  awardedAt: string;
};

export type Blueprint = DesignProject & {
  createdAt: string;
  isLimited?: boolean;
  legendGift?: LegendGift;
};

export type GenerateResponse = {
  image: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };
  model: string;
};

export type ApiError = {
  error: { code: string; message: string };
};

export type LegendGiftResponse = {
  guest: { name: string; title: string; stayStory: string; note: string };
  gift: {
    name: string;
    designKind: "room" | "zone";
    roomTypeId: string;
    bedTypeId: string;
    zoneTypeId?: string;
    areaSqm: number;
    furniture: FurnitureSelection[];
    stylePrompt: string;
  };
  model: string;
};

export type FloorPlacement = {
  id: string;
  kind: "blueprint" | "corridor" | "staff";
  blueprintId?: string;
  areaSqm: number;
  allocatedAreaSqm: number;
  shapes: FloorPoint[][];
  journeyRole: "arrival" | "stay" | "restore" | "gather";
};

export type FloorPoint = { x: number; y: number };

export type FloorPlan = {
  id: string;
  floorNumber: number;
  name: string;
  placements: FloorPlacement[];
  updatedAt: string;
};
