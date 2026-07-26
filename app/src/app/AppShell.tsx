import { NavLink, Outlet } from "react-router-dom";

export function AppShell() {
  return (
    <div>
      <nav aria-label="主导航">
        <NavLink to="/">酒店总览</NavLink>
        <NavLink to="/canvas">楼层画布</NavLink>
        <NavLink to="/design">设计</NavLink><NavLink to="/floor-plan">楼层</NavLink><NavLink to="/operations">运营</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
