import { describe, expect, it } from "vitest";
import { isValidVisualAssetPath } from "./validateBrowserGameState";

describe("visual asset path validation", () => {
  it("accepts legacy local visuals and exact native content digests", () => {
    expect(isValidVisualAssetPath("/visuals/master.png")).toBe(true);
    expect(isValidVisualAssetPath(`cloudinn-asset://${"a".repeat(64)}`)).toBe(true);
  });

  it.each([
    "cloudinn-asset://asset-1",
    `cloudinn-asset://${"A".repeat(64)}`,
    `cloudinn-asset://${"a".repeat(64)}/extra`,
    "cloudinn-asset://../secret",
    "/visuals/../secret",
    "file:///Users/private/asset.png",
  ])("rejects noncanonical resolver path %s", (value) => {
    expect(isValidVisualAssetPath(value)).toBe(false);
  });
});
