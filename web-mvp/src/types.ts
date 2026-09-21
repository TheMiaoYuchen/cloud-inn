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

export type Blueprint = DesignProject & {
  createdAt: string;
};

export type GenerateResponse = {
  image: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };
  model: string;
};

export type ApiError = {
  error: { code: string; message: string };
};

export type FloorPlacement = {
  id: string;
  blueprintId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  areaSqm: number;
  journeyRole: "arrival" | "stay" | "restore" | "gather";
};

export type FloorPlan = {
  id: "floor-01";
  placements: FloorPlacement[];
  updatedAt: string;
};
