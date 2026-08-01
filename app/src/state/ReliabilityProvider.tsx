import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  selectSave(saveId: SaveId): void;
  registerSave(save: SaveSummary): void;
};

const ReliabilityContext = createContext<ReliabilityContextValue | null>(null);

export function ReliabilityProvider({ children, port }: { children: ReactNode; port: ReliabilityPort }) {
  const [saves, setSaves] = useState<readonly SaveSummary[]>([]);
  const [activeSaveId, setActiveSaveId] = useState<SaveId | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSaves = useCallback(async () => {
    const next = await port.listSaves();
    setSaves(next);
    setActiveSaveId((current) => current && next.some((save) => save.saveId === current)
      ? current
      : next[0]?.saveId ?? null);
    return next;
  }, [port]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    port.listSaves().then((next) => {
      if (!alive) return;
      setSaves(next);
      setActiveSaveId(next[0]?.saveId ?? null);
      setLoading(false);
    }, () => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [port]);

  const registerSave = useCallback((save: SaveSummary) => {
    setSaves((current) => [...current.filter((item) => item.saveId !== save.saveId), save]);
    setActiveSaveId(save.saveId);
  }, []);

  const value = useMemo<ReliabilityContextValue>(() => ({
    port,
    saves,
    activeSaveId,
    loading,
    refreshSaves,
    selectSave: setActiveSaveId,
    registerSave,
  }), [activeSaveId, loading, port, refreshSaves, registerSave, saves]);

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
