import type { ReliabilityPort } from "../../application/ports/ReliabilityPort";
import { createNewGame } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";
import type { SaveSummary } from "../../domain/reliability/reliabilityTypes";
import { LocalStorageSavePort } from "./LocalStorageSavePort";

const METADATA_PREFIX = "cloud-inn:save-metadata:";
const SAVE_PREFIX = "cloud-inn:save:";

type BrowserSaveMetadata = { displayName: string; metadataRevision: number; createdAtMs: number; renamedAtMs: number };

function normalizeName(value: string): string {
  const name = value.trim().normalize("NFC");
  const Segmenter = (Intl as unknown as {
    Segmenter?: new () => { segment(value: string): Iterable<unknown> };
  }).Segmenter;
  const graphemes = Segmenter
    ? [...new Segmenter().segment(name)].length
    : Array.from(name).length;
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name) || graphemes > 40) {
    throw new Error("存档名称无效");
  }
  return name;
}

function getMetadata(saveId: string): BrowserSaveMetadata | null {
  const value = window.localStorage.getItem(`${METADATA_PREFIX}${saveId}`);
  if (!value) return null;
  try {
    const metadata: unknown = JSON.parse(value);
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
    const candidate = metadata as Partial<BrowserSaveMetadata>;
    if (typeof candidate.displayName !== "string" || !Number.isSafeInteger(candidate.metadataRevision) ||
      !Number.isSafeInteger(candidate.createdAtMs) || !Number.isSafeInteger(candidate.renamedAtMs)) return null;
    return candidate as BrowserSaveMetadata;
  } catch { return null; }
}

/** Deterministic browser-only equivalent used by UI tests and the web fallback. */
export class BrowserReliabilityPort implements Pick<ReliabilityPort, "listSaves" | "createSave" | "renameSave"> {
  constructor(
    private readonly savePort = new LocalStorageSavePort(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async listSaves(): Promise<readonly SaveSummary[]> {
    const summaries: SaveSummary[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(SAVE_PREFIX)) continue;
      const saveId = key.slice(SAVE_PREFIX.length);
      const metadata = getMetadata(saveId);
      if (!metadata) continue;
      try {
        const game = await this.savePort.load(saveId);
        if (!game) continue;
        summaries.push({ saveId, displayName: metadata.displayName, metadataRevision: metadata.metadataRevision,
          gameRevision: game.revision, currentDay: game.currentDay, roomCount: game.floor.rooms.length,
          schemaHealthy: true, recoveryAvailable: false, lastPlayedAtMs: Math.max(metadata.createdAtMs, metadata.renamedAtMs) });
      } catch { /* Invalid browser data is deliberately omitted from the chooser. */ }
    }
    return summaries.sort((left, right) => left.saveId.localeCompare(right.saveId));
  }

  async createSave(displayName: string): Promise<SaveSummary> {
    const name = normalizeName(displayName);
    let ordinal = 1;
    let saveId: SaveId;
    do { saveId = `browser-save-${ordinal.toString().padStart(4, "0")}`; ordinal += 1; }
    while (window.localStorage.getItem(`${SAVE_PREFIX}${saveId}`) !== null);
    const time = this.now();
    await this.savePort.commit(0, { ...createNewGame(saveId), revision: 1 });
    const metadata: BrowserSaveMetadata = { displayName: name, metadataRevision: 0, createdAtMs: time, renamedAtMs: time };
    window.localStorage.setItem(`${METADATA_PREFIX}${saveId}`, JSON.stringify(metadata));
    return { saveId, displayName: name, metadataRevision: 0, gameRevision: 1, currentDay: 0, roomCount: 0,
      schemaHealthy: true, recoveryAvailable: false, lastPlayedAtMs: time };
  }

  async renameSave(saveId: SaveId, displayName: string, expectedMetadataRevision: number): Promise<SaveSummary> {
    const name = normalizeName(displayName);
    const metadata = getMetadata(saveId);
    const game = await this.savePort.load(saveId);
    if (!metadata || !game) throw new Error("存档不存在");
    if (metadata.metadataRevision !== expectedMetadataRevision) throw new Error("存档已更新，请重新加载");
    const renamedAtMs = this.now();
    const next = { ...metadata, displayName: name, metadataRevision: metadata.metadataRevision + 1, renamedAtMs };
    window.localStorage.setItem(`${METADATA_PREFIX}${saveId}`, JSON.stringify(next));
    return { saveId, displayName: name, metadataRevision: next.metadataRevision, gameRevision: game.revision,
      currentDay: game.currentDay, roomCount: game.floor.rooms.length, schemaHealthy: true,
      recoveryAvailable: false, lastPlayedAtMs: Math.max(next.createdAtMs, renamedAtMs) };
  }
}
