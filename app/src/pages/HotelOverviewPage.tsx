import { Navigate } from "react-router-dom";
import { useGame } from "../state/GameProvider";

export function HotelOverviewPage() {
  const { state, commandPending, error, commands } = useGame();
  if (state?.phase4) return <Navigate to="/building" replace />;
  return (
    <main>
      <h1>Cloud Inn</h1>
      <p>你的高奢酒店从这里开始。</p>
      {state?.phase === "open" ? <>
        <p>可用现金 <strong data-testid="hotel-cash-cents" data-value={state.cashCents}>¥{state.cashCents / 100}</strong></p>
        <button type="button" disabled={commandPending} onClick={() => void commands.initializeContentScale()}>
          {commandPending ? "正在启用…" : "启用塔楼与公共空间"}
        </button>
      </> : <a href="#/design">开始设计</a>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
