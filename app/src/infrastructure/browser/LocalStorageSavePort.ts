import type { SavePort } from "../../application/ports/SavePort";
import type { GameState } from "../../domain/game/state";
import type { SaveId } from "../../domain/primitives";
import { validateBrowserGameState } from "./validateBrowserGameState";

const SAVE_PREFIX = "cloud-inn:save:";
const LOCK_PREFIX = "cloud-inn:save-lock:";

type StoredEnvelope = {
  formatVersion: 1;
  writeToken: string;
  game: unknown;
};

function isEnvelope(value: unknown): value is StoredEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.formatVersion === 1 &&
    typeof candidate.writeToken === "string" &&
    "game" in candidate;
}

function parseStored(raw: string, saveId: SaveId): { game: GameState; token: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isEnvelope(parsed)) {
      return {
        game: validateBrowserGameState(parsed.game, saveId),
        token: parsed.writeToken,
      };
    }
    return { game: validateBrowserGameState(parsed, saveId), token: null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("浏览器存档已损坏")) throw error;
    throw new Error("浏览器存档已损坏，无法加载");
  }
}

function makeToken(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function withSafeLock<T>(
  locks: LockManager | null,
  saveId: SaveId,
  work: () => Promise<T>,
): Promise<T> {
  if (!locks) {
    throw new Error("浏览器不支持安全存档锁，无法保存");
  }
  return locks.request(`${LOCK_PREFIX}${saveId}`, work);
}

export class LocalStorageSavePort implements SavePort {
  constructor(
    private readonly locks: LockManager | null = globalThis.navigator?.locks ?? null,
  ) {}

  async load(saveId: SaveId): Promise<GameState | null> {
    const raw = window.localStorage.getItem(`${SAVE_PREFIX}${saveId}`);
    return raw ? parseStored(raw, saveId).game : null;
  }

  async commit(expectedRevision: number, next: GameState): Promise<void> {
    await withSafeLock(this.locks, next.saveId, async () => {
      const key = `${SAVE_PREFIX}${next.saveId}`;
      const raw = window.localStorage.getItem(key);
      const current = raw ? parseStored(raw, next.saveId).game : null;
      const validatedNext = validateBrowserGameState(next, next.saveId);
      if (
        expectedRevision !== (current?.revision ?? 0) ||
        validatedNext.revision !== expectedRevision + 1
      ) {
        throw new Error("存档已更新，请重新加载");
      }
      const writeToken = makeToken();
      const envelope: StoredEnvelope = {
        formatVersion: 1,
        writeToken,
        game: validatedNext,
      };
      window.localStorage.setItem(key, JSON.stringify(envelope));
      const verified = window.localStorage.getItem(key);
      if (!verified) throw new Error("浏览器存档写入失败，请重试");
      const readBack = parseStored(verified, next.saveId);
      if (readBack.token !== writeToken || readBack.game.revision !== validatedNext.revision) {
        throw new Error("存档已更新，请重新加载");
      }
    });
  }
}
