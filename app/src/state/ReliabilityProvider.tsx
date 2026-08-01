import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReliabilityPort } from "../application/ports/ReliabilityPort";
import type { SaveId } from "../domain/primitives";
import type { SaveSummary } from "../domain/reliability/reliabilityTypes";

type ReliabilityContextValue = {
  port: ReliabilityPort;
  saves: readonly SaveSummary[];
  activeSaveId: SaveId | null;
  loading: boolean;
  refreshSaves(): Promise<readonly SaveSummary[]>;
  selectSave(saveId: SaveId): Promise<void>;
  registerSave(save: SaveSummary): Promise<void>;
};

const ReliabilityContext = createContext<ReliabilityContextValue | null>(null);

export function ReliabilityProvider({ children, port }: { children: ReactNode; port: ReliabilityPort }) {
  const [saves, setSaves] = useState<readonly SaveSummary[]>([]);
  const [activeSaveId, setActiveSaveId] = useState<SaveId | null>(null);
  const [loading, setLoading] = useState(true);
  const activeSaveIdRef = useRef<SaveId | null>(null);
  const intentRef = useRef(0);
  const activationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const commitActiveSave = useCallback((saveId: SaveId | null) => {
    activeSaveIdRef.current = saveId;
    setActiveSaveId(saveId);
  }, []);

  const activateForIntent = useCallback((saveId: SaveId, intent: number) => {
    const task = activationQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (intentRef.current !== intent) return false;
        try {
          await port.activateSaveAssets(saveId);
          return intentRef.current === intent;
        } catch (error) {
          if (intentRef.current === intent) {
            const previous = activeSaveIdRef.current;
            if (previous && previous !== saveId) {
              try { await port.activateSaveAssets(previous); }
              catch { commitActiveSave(null); }
            }
            throw error;
          }
          return false;
        }
      });
    activationQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, [commitActiveSave, port]);

  const refreshSaves = useCallback(async () => {
    const intent = ++intentRef.current;
    const next = await port.listSaves();
    if (intentRef.current !== intent) return next;
    setSaves(next);
    const current = activeSaveIdRef.current;
    const selected = current && next.some((save) => save.saveId === current)
      ? current
      : next[0]?.saveId ?? null;
    if (!selected) {
      commitActiveSave(null);
      return next;
    }
    if (await activateForIntent(selected, intent)) commitActiveSave(selected);
    return next;
  }, [activateForIntent, commitActiveSave, port]);

  useEffect(() => {
    let alive = true;
    const intent = ++intentRef.current;
    setLoading(true);
    commitActiveSave(null);
    void (async () => {
      try {
        const next = await port.listSaves();
        if (!alive || intentRef.current !== intent) return;
        setSaves(next);
        const selected = next[0]?.saveId ?? null;
        if (selected && await activateForIntent(selected, intent) && alive) {
          commitActiveSave(selected);
        }
      } catch {
        // Fail closed: without a verified asset scope no save becomes active.
      } finally {
        if (alive && intentRef.current === intent) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activateForIntent, commitActiveSave, port]);

  const selectSave = useCallback(async (saveId: SaveId) => {
    const intent = ++intentRef.current;
    if (await activateForIntent(saveId, intent)) commitActiveSave(saveId);
  }, [activateForIntent, commitActiveSave]);

  const registerSave = useCallback(async (save: SaveSummary) => {
    setSaves((current) => [...current.filter((item) => item.saveId !== save.saveId), save]);
    await selectSave(save.saveId);
  }, [selectSave]);

  const value = useMemo<ReliabilityContextValue>(() => ({
    port,
    saves,
    activeSaveId,
    loading,
    refreshSaves,
    selectSave,
    registerSave,
  }), [activeSaveId, loading, port, refreshSaves, registerSave, saves, selectSave]);

  return <ReliabilityContext.Provider value={value}>{children}</ReliabilityContext.Provider>;
}

export function useReliability(): ReliabilityContextValue {
  const value = useContext(ReliabilityContext);
  if (!value) throw new Error("ReliabilityProvider missing");
  return value;
}

export function useOptionalReliability(): ReliabilityContextValue | null {
  return useContext(ReliabilityContext);
}
