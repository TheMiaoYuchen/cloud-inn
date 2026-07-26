export type SaveId = string;
export type RoomBlueprintId = string;
export type RoomInstanceId = string;

export type MoneyCents = number;
export type BasisPoints = number;
export type Revision = number;
export type GameDay = number;

export function assertSafeMoney(value: number): MoneyCents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("金额必须是非负整数分");
  }

  return value;
}
