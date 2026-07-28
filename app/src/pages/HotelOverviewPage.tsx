import { Navigate } from "react-router-dom";
import { useGame } from "../state/GameProvider";

export function HotelOverviewPage() {
  const { state } = useGame();
  if (state?.phase4) return <Navigate to="/building" replace />;
  return (
    <main>
      <h1>Cloud Inn</h1>
      <p>你的高奢酒店从这里开始。</p>
      <a href="#/design">开始设计</a>
    </main>
  );
}
