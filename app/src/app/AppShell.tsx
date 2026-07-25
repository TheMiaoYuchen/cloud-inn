import { NavLink, Outlet } from "react-router-dom";

export function AppShell() {
  return (
    <div>
      <nav aria-label="主导航">
        <NavLink to="/">酒店总览</NavLink>
        <NavLink to="/canvas">楼层画布</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
