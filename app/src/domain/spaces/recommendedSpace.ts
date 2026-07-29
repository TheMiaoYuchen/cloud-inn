import type { PublicSpaceType } from "../facilities/facilityTypes";
import {
  addSpaceDoor,
  createSpaceDraft,
  paintSpaceRectangle,
  placeSpaceItem,
} from "./spaceEditor";
import type { SpaceDraft } from "./spaceTypes";

function zone(draft: SpaceDraft, id: string, x: number, y: number, width: number, height: number) {
  return paintSpaceRectangle(draft, { x, y, width, height }, id);
}

function item(draft: SpaceDraft, id: string, catalogItemId: string, x: number, y: number, width = 1, height = 1) {
  return placeSpaceItem(draft, { id, catalogItemId, x, y, width, height, rotation: 0 });
}

function repeated(draft: SpaceDraft, catalogItemId: string, count: number, x: number, y: number) {
  let next = draft;
  for (let index = 0; index < count; index += 1) {
    next = item(next, `recommended-item:${index + 1}`, catalogItemId, x + index, y);
  }
  return next;
}

export function createRecommendedSpace(type: PublicSpaceType): SpaceDraft {
  let draft = createSpaceDraft(type, 24, 24);
  if (type === "all-day-dining" || type === "chinese-restaurant" || type === "bar") {
    const serviceZone = type === "bar" ? "zone:bar-service" : "zone:kitchen";
    const guestItem = type === "bar" ? "item:lounge-seat" : "item:dining-table";
    const serviceItem = type === "bar" ? "item:bar-counter" : "item:service-counter";
    draft = zone(draft, "zone:seating", 0, 0, 10, 10);
    draft = zone(draft, "zone:service-route", 10, 0, 1, 10);
    draft = zone(draft, serviceZone, 11, 0, 3, 10);
    draft = repeated(draft, guestItem, type === "chinese-restaurant" ? 6 : 8, 0, 1);
    return item(draft, "recommended-service", serviceItem, 11, 1);
  }
  if (type === "spa") {
    draft = zone(draft, "zone:treatment", 0, 0, 4, 4);
    draft = zone(draft, "zone:quiet", 4, 0, 2, 4);
    draft = zone(draft, "zone:reception", 0, 4, 4, 2);
    draft = zone(draft, "zone:wet", 4, 4, 4, 4);
    draft = addSpaceDoor(draft, { x: 0, y: 5, side: "south" });
    draft = item(draft, "recommended-reception", "item:reception-desk", 0, 4);
    draft = item(draft, "recommended-treatment-1", "item:treatment-bed", 0, 0);
    return item(draft, "recommended-treatment-2", "item:treatment-bed", 2, 0);
  }
  if (type === "gym") {
    draft = zone(draft, "zone:fitness", 0, 0, 10, 8);
    return repeated(draft, "item:fitness-station", 4, 0, 1);
  }
  if (type === "ballroom") {
    draft = zone(draft, "zone:event", 0, 0, 16, 10);
    draft = zone(draft, "zone:back-of-house", 16, 0, 4, 10);
    draft = zone(draft, "zone:stage", 0, 10, 16, 2);
    draft = zone(draft, "zone:service-route", 16, 10, 4, 2);
    draft = zone(draft, "zone:partition", 20, 0, 1, 12);
    draft = addSpaceDoor(addSpaceDoor(draft, { x: 0, y: 0, side: "north" }), { x: 10, y: 0, side: "north" });
    draft = repeated(draft, "item:event-table", 8, 1, 1);
    return item(draft, "recommended-service", "item:service-counter", 16, 1);
  }
  throw new Error("该公共空间暂未提供推荐布局");
}
