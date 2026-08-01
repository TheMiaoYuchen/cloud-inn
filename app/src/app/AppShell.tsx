import { NavLink, Outlet } from "react-router-dom";
import { useGame } from "../state/GameProvider";
import { useOptionalReliability } from "../state/ReliabilityProvider";

const phaseRank = { design: 0, floor: 1, ready: 2, open: 3 } as const;

export function AppShell() {
  const { state } = useGame();
  const reliability = useOptionalReliability();
  const currentRank = state ? phaseRank[state.phase] : 0;
  const canVisit = (required: keyof typeof phaseRank) => currentRank >= phaseRank[required];
  const progressLink = (to: string, label: string, required: keyof typeof phaseRank) => {
    const enabled = canVisit(required);
    return <NavLink to={to} aria-disabled={!enabled || undefined} tabIndex={enabled ? undefined : -1} onClick={(event) => { if (!enabled) event.preventDefault(); }}>{label}</NavLink>;
  };
  return (
    <div>
      <nav aria-label="主导航">
        <NavLink to="/">酒店总览</NavLink>
        <NavLink to="/canvas">楼层画布</NavLink>
        {state?.phase4
          ? <><NavLink to="/building">塔楼</NavLink><NavLink to="/public-spaces/design">空间设计</NavLink><NavLink to="/compendium">酒店百科</NavLink></>
          : <>{progressLink("/design", "设计", "design")}{progressLink("/floor-plan", "楼层", "floor")}</>}
        {progressLink("/operations", "运营", "ready")}
        {reliability && <><NavLink to="/studio">效果图</NavLink><NavLink to="/saves">存档</NavLink><NavLink to="/diagnostics">诊断</NavLink></>}
      </nav>
      <Outlet />
    </div>
  );
}
