import type { VisualProvider } from "../../application/ports/VisualProvider";

export class PlaceholderVisualProvider implements VisualProvider {
  async generate(): Promise<{ assetPath: string }> {
    return { assetPath: "/visuals/prototype-room.svg" };
  }
}
