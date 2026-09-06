import { useQuery } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from "@tanstack/react-router";
import { fetchHealth } from "./api";
import { ImportPage, OpportunitiesPage, OpportunityPage, ProfilePage } from "./pages";

function Layout() {
  const health = useQuery({ queryKey: ["runtime-health"], queryFn: () => fetchHealth(), retry: false, refetchInterval: 5_000 });
  return <>
    <header className="app-header">
      <Link className="brand" to="/">Job Research</Link>
      <nav className="header-actions" aria-label="辅助导航">
        <Link to="/opportunities">历史记录</Link>
        <Link to="/profile">简历与偏好</Link>
      </nav>
    </header>
    {health.isError ? <div className="runtime-banner error" role="alert">无法连接本地服务，请确认 Server 已启动。</div> : null}
    {health.data?.status === "degraded" ? <div className="runtime-banner degraded" role="alert">部分组件不可用，分析任务可能暂时无法完成。</div> : null}
    <Outlet />
  </>;
}

const rootRoute = createRootRoute({ component: Layout });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ImportPage });
const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfilePage });
const importRoute = createRoute({ getParentRoute: () => rootRoute, path: "/import", component: ImportPage });
const opportunitiesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/opportunities", component: OpportunitiesPage });
export const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/opportunities/$opportunityId", component: OpportunityPage });
export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, profileRoute, importRoute, opportunitiesRoute, detailRoute]) });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }
export function App() { return <RouterProvider router={router} />; }
