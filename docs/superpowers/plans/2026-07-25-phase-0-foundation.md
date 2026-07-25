# Cloud Inn Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a tested Tauri 2 macOS application foundation with React navigation and one correctly managed PixiJS canvas.

**Architecture:** Keep the repository documents at the root and generate the application in `app/`. Browser automation verifies the Vite frontend, while Rust checks and a separate macOS smoke checklist verify the Tauri boundary because Playwright cannot drive the production WKWebView reliably.

**Tech Stack:** Node.js 24.18.0, npm, Rust stable, Tauri 2, React, TypeScript, Vite, PixiJS, React Router, Vitest, Testing Library, Playwright.

---

## File Map

- Create: `.nvmrc` - observed Node runtime pin.
- Create: `rust-toolchain.toml` - repository Rust channel and formatter/components.
- Create: `app/` - generated Tauri application and both lockfiles.
- Modify: `app/package.json` - exact dependencies and verification scripts.
- Create: `app/vitest.config.ts` - unit/component test environment.
- Create: `app/playwright.config.ts` - browser E2E against Vite.
- Create: `app/src/test/setup.ts` - jest-dom registration and cleanup.
- Create: `app/src/app/router.tsx` - hash-based route table.
- Create: `app/src/app/App.tsx` - application shell and navigation.
- Create: `app/src/app/AppShell.tsx` - route layout without circular imports.
- Create: `app/src/pages/HotelOverviewPage.tsx` - default page.
- Create: `app/src/pages/CanvasPage.tsx` - Pixi canvas page.
- Create: `app/src/canvas/viewport.ts` - pure viewport calculation.
- Create: `app/src/canvas/MinimalCanvas.tsx` - Pixi lifecycle boundary.
- Create: `app/e2e/navigation.spec.ts` - real-browser navigation/canvas smoke.
- Create: `docs/testing/macos-smoke.md` - packaged WKWebView verification.

### Task 1: Pin and Verify the Development Environment

**Files:**
- Create: `.nvmrc`
- Create: `rust-toolchain.toml`

- [ ] **Step 1: Write the repository runtime pins**

```text
# .nvmrc
24.18.0
```

```toml
# rust-toolchain.toml
[toolchain]
channel = "stable"
components = ["clippy", "rustfmt"]
profile = "minimal"
```

- [ ] **Step 2: Verify Node and macOS command-line tools**

Run:

```bash
node --version
npm --version
xcode-select -p
uname -m
```

Expected: Node prints `v24.18.0`, npm prints a version, `xcode-select` prints `/Library/Developer/CommandLineTools` or an Xcode developer path, and architecture prints `arm64` or `x86_64`.

- [ ] **Step 3: Install Rust only if `cargo` is missing**

Run:

```bash
command -v cargo || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
rustc --version
cargo --version
cargo clippy --version
```

Expected: all Rust commands print versions. If the installer cannot reach the network, stop this task and report the network error; do not scaffold a partial Tauri project.

- [ ] **Step 4: Commit the environment pins**

```bash
git add .nvmrc rust-toolchain.toml
git commit -m "chore: pin development runtimes"
```

### Task 2: Generate and Lock the Tauri Application

**Files:**
- Create: `app/package.json`
- Create: `app/package-lock.json`
- Create: `app/src-tauri/Cargo.toml`
- Create: `app/src-tauri/Cargo.lock`
- Modify: `app/src-tauri/tauri.conf.json`

- [ ] **Step 1: Generate the official scaffold**

Run from the repository root:

```bash
npm create tauri-app@latest app
```

Choose exactly: TypeScript/JavaScript, npm, React, TypeScript, Tauri 2. If `app/` exists before this step, stop and inspect it; do not overwrite it.

Expected: the command creates `app/`, including React/Vite files and `app/src-tauri/`.

- [ ] **Step 2: Install the smallest runtime dependency set and lock it**

Run:

```bash
cd app
npm install --save-exact pixi.js react-router-dom
npm install
cd src-tauri
cargo generate-lockfile
cd ../..
```

Expected: `app/package-lock.json` and `app/src-tauri/Cargo.lock` exist. `@tauri-apps/api`, `@tauri-apps/cli`, and Rust `tauri` all use major version 2.

- [ ] **Step 3: Set stable application identity and window bounds**

Update the generated `app/src-tauri/tauri.conf.json` values without replacing other generated fields:

```json
{
  "productName": "Cloud Inn",
  "identifier": "com.cloudinn.game",
  "app": {
    "windows": [
      {
        "title": "Cloud Inn",
        "width": 1440,
        "height": 900,
        "minWidth": 1100,
        "minHeight": 720,
        "resizable": true
      }
    ]
  }
}
```

- [ ] **Step 4: Verify the untouched generated application**

Run:

```bash
cd app
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Vite build and Rust check both exit 0.

- [ ] **Step 5: Commit the generated foundation**

```bash
git add app
git commit -m "chore: scaffold Cloud Inn desktop app"
```

### Task 3: Add the Automated Test Harness

**Files:**
- Modify: `app/package.json`
- Create: `app/vitest.config.ts`
- Create: `app/src/test/setup.ts`
- Create: `app/src/test/harness.test.ts`

- [ ] **Step 1: Install exact test dependencies**

Run:

```bash
cd app
npm install --save-dev --save-exact vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Add verification scripts to `app/package.json`**

Merge these keys into `scripts`:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test",
  "typecheck": "tsc --noEmit",
  "check": "npm run typecheck && npm test && npm run build"
}
```

- [ ] **Step 3: Configure Vitest and the test setup**

```ts
// app/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
```

```ts
// app/src/test/setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

- [ ] **Step 4: Write the first failing harness test**

```ts
// app/src/test/harness.test.ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs TypeScript tests", () => {
    expect(0.25 * 96).toBe(23);
  });
});
```

- [ ] **Step 5: Run it and verify the intentional failure**

Run: `cd app && npm test -- src/test/harness.test.ts`

Expected: FAIL because the received value is `24`, not `23`.

- [ ] **Step 6: Correct the assertion and verify the harness**

```ts
expect(0.25 * 96).toBe(24);
```

Run:

```bash
cd app
npm run typecheck
npm test
```

Expected: both commands exit 0 and the harness test passes.

- [ ] **Step 7: Commit the test harness**

```bash
git add app/package.json app/package-lock.json app/vitest.config.ts app/src/test
git commit -m "test: add frontend verification harness"
```

### Task 4: Build the Tested Application Shell and Routes

**Files:**
- Create: `app/src/app/router.tsx`
- Create: `app/src/app/App.tsx`
- Create: `app/src/app/AppShell.tsx`
- Create: `app/src/app/App.test.tsx`
- Create: `app/src/pages/HotelOverviewPage.tsx`
- Create: `app/src/pages/CanvasPage.tsx`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Write the failing navigation tests**

```tsx
// app/src/app/App.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "#/";
  });

  it("opens on the hotel overview", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });

  it("navigates to and from the canvas", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "楼层画布" }));
    expect(screen.getByRole("heading", { name: "楼层画布" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "酒店总览" }));
    expect(screen.getByRole("heading", { name: "Cloud Inn" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify missing application modules**

Run: `cd app && npm test -- src/app/App.test.tsx`

Expected: FAIL because `./App` does not exist.

- [ ] **Step 3: Implement the route table and pages**

```tsx
// app/src/pages/HotelOverviewPage.tsx
export function HotelOverviewPage() {
  return (
    <main>
      <h1>Cloud Inn</h1>
      <p>你的高奢酒店从这里开始。</p>
    </main>
  );
}
```

```tsx
// app/src/pages/CanvasPage.tsx
export function CanvasPage() {
  return (
    <main>
      <h1>楼层画布</h1>
      <div data-testid="canvas-slot" />
    </main>
  );
}
```

```tsx
// app/src/app/AppShell.tsx
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
```

```tsx
// app/src/app/router.tsx
import { createHashRouter, Navigate } from "react-router-dom";
import { CanvasPage } from "../pages/CanvasPage";
import { HotelOverviewPage } from "../pages/HotelOverviewPage";
import { AppShell } from "./AppShell";

export function createAppRouter() {
  return createHashRouter([
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <HotelOverviewPage /> },
        { path: "canvas", element: <CanvasPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}
```

```tsx
// app/src/app/App.tsx
import { RouterProvider } from "react-router-dom";
import { useMemo } from "react";
import { createAppRouter } from "./router";

export function App() {
  const router = useMemo(createAppRouter, []);
  return <RouterProvider router={router} />;
}
```

```tsx
// app/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Run route tests and the build**

Run:

```bash
cd app
npm test -- src/app/App.test.tsx
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the application shell**

```bash
git add app/src
git commit -m "feat: add Cloud Inn application shell"
```

### Task 5: Add Pure Viewport Math

**Files:**
- Create: `app/src/canvas/viewport.ts`
- Create: `app/src/canvas/viewport.test.ts`

- [ ] **Step 1: Write failing viewport tests**

```ts
// app/src/canvas/viewport.test.ts
import { describe, expect, it } from "vitest";
import { fitViewport } from "./viewport";

describe("fitViewport", () => {
  it("clamps dimensions and device pixel ratio", () => {
    expect(fitViewport(0, 400, 4)).toEqual({ width: 1, height: 400, resolution: 2 });
  });

  it("uses valid dimensions unchanged", () => {
    expect(fitViewport(1280, 720, 1)).toEqual({ width: 1280, height: 720, resolution: 1 });
  });
});
```

- [ ] **Step 2: Verify the tests fail because the function is missing**

Run: `cd app && npm test -- src/canvas/viewport.test.ts`

Expected: FAIL with a missing-module or missing-export error.

- [ ] **Step 3: Implement the pure viewport function**

```ts
// app/src/canvas/viewport.ts
export interface ViewportSize {
  width: number;
  height: number;
  resolution: number;
}

export function fitViewport(width: number, height: number, devicePixelRatio: number): ViewportSize {
  return {
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
    resolution: Math.min(2, Math.max(1, devicePixelRatio)),
  };
}
```

- [ ] **Step 4: Verify viewport tests pass**

Run: `cd app && npm test -- src/canvas/viewport.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit viewport math**

```bash
git add app/src/canvas
git commit -m "feat: add canvas viewport calculation"
```

### Task 6: Mount and Destroy PixiJS Safely

**Files:**
- Create: `app/src/canvas/MinimalCanvas.tsx`
- Create: `app/src/canvas/MinimalCanvas.test.tsx`
- Modify: `app/src/pages/CanvasPage.tsx`

- [ ] **Step 1: Write a lifecycle-focused component test**

```tsx
// app/src/canvas/MinimalCanvas.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { MinimalCanvas } from "./MinimalCanvas";

vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: vi.fn() };
    renderer = { resize: vi.fn() };
    init = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
  },
  Graphics: class {
    roundRect() { return this; }
    fill() { return this; }
    stroke() { return this; }
  },
}));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

describe("MinimalCanvas", () => {
  it("provides one host for the Pixi canvas", () => {
    const { unmount } = render(<MinimalCanvas />);
    expect(screen.getAllByTestId("pixi-host")).toHaveLength(1);
    unmount();
    expect(screen.queryByTestId("pixi-host")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify the test fails because the component is missing**

Run: `cd app && npm test -- src/canvas/MinimalCanvas.test.tsx`

Expected: FAIL with missing module `./MinimalCanvas`.

- [ ] **Step 3: Implement asynchronous Pixi initialization with complete cleanup**

```tsx
// app/src/canvas/MinimalCanvas.tsx
import { Application, Graphics } from "pixi.js";
import { useEffect, useRef } from "react";
import { fitViewport } from "./viewport";

export function MinimalCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let app: Application | undefined;

    const start = async () => {
      const size = fitViewport(host.clientWidth, host.clientHeight, window.devicePixelRatio);
      const nextApp = new Application();
      await nextApp.init({
        width: size.width,
        height: size.height,
        resolution: size.resolution,
        autoDensity: true,
        background: "#182321",
        antialias: true,
      });

      if (cancelled) {
        nextApp.destroy(true, { children: true });
        return;
      }

      app = nextApp;
      nextApp.canvas.dataset.testid = "pixi-canvas";
      host.appendChild(nextApp.canvas);

      const marker = new Graphics()
        .roundRect(40, 40, 240, 140, 12)
        .fill("#c9aa75")
        .stroke({ color: "#f0dfbe", width: 2 });
      nextApp.stage.addChild(marker);
    };

    void start();

    const observer = new ResizeObserver(() => {
      if (!app) return;
      const size = fitViewport(host.clientWidth, host.clientHeight, window.devicePixelRatio);
      app.renderer.resize(size.width, size.height);
    });
    observer.observe(host);

    return () => {
      cancelled = true;
      observer.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} data-testid="pixi-host" style={{ width: "100%", height: 560 }} />;
}
```

- [ ] **Step 4: Render the canvas on its page**

```tsx
// app/src/pages/CanvasPage.tsx
import { MinimalCanvas } from "../canvas/MinimalCanvas";

export function CanvasPage() {
  return (
    <main>
      <h1>楼层画布</h1>
      <MinimalCanvas />
    </main>
  );
}
```

- [ ] **Step 5: Run component, type, and build checks**

Run:

```bash
cd app
npm test -- src/canvas/MinimalCanvas.test.tsx
npm run typecheck
npm run build
```

Expected: all commands exit 0. The component test uses the explicit Pixi mock above because jsdom has no WebGL; Task 7 verifies real Pixi rendering in Chromium.

- [ ] **Step 6: Commit the Pixi boundary**

```bash
git add app/src/canvas app/src/pages/CanvasPage.tsx
git commit -m "feat: add managed Pixi canvas"
```

### Task 7: Add Real-Browser Navigation and Canvas E2E

**Files:**
- Modify: `app/playwright.config.ts`
- Create: `app/e2e/navigation.spec.ts`

- [ ] **Step 1: Configure Playwright against Vite**

```ts
// app/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 2: Write the failing browser flow**

```ts
// app/e2e/navigation.spec.ts
import { expect, test } from "@playwright/test";

test("opens the Pixi floor canvas and returns home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Cloud Inn" })).toBeVisible();
  await page.getByRole("link", { name: "楼层画布" }).click();
  await expect(page.getByRole("heading", { name: "楼层画布" })).toBeVisible();
  await expect(page.getByTestId("pixi-canvas")).toBeVisible();
  await page.getByRole("link", { name: "酒店总览" }).click();
  await expect(page.getByRole("heading", { name: "Cloud Inn" })).toBeVisible();
});
```

- [ ] **Step 3: Run the E2E test and fix only observed integration issues**

Run: `cd app && npm run test:e2e`

Expected: 1 test passes. If Pixi startup fails, inspect the browser error and adjust initialization; do not replace the assertion with a fake canvas or screenshot baseline.

- [ ] **Step 4: Commit browser E2E**

```bash
git add app/playwright.config.ts app/e2e
git commit -m "test: cover navigation and Pixi rendering"
```

### Task 8: Verify the Full Foundation and macOS Boundary

**Files:**
- Create: `docs/testing/macos-smoke.md`

- [ ] **Step 1: Write the macOS smoke checklist**

```markdown
# Cloud Inn macOS Smoke Test

- [ ] `npm run tauri dev` opens one window titled Cloud Inn.
- [ ] Hotel overview is the initial view.
- [ ] Floor Canvas displays one gold marker on a dark background.
- [ ] Resizing the window keeps one canvas and produces no visible stretching artifacts.
- [ ] Navigating away and back does not create duplicate canvases.
- [ ] Closing and reopening the development app succeeds.
- [ ] `npm run tauri build -- --debug` creates a debug app bundle.
- [ ] Opening the debug app repeats the same navigation and resize behavior.

Playwright covers the Vite frontend in Chromium; this checklist covers the macOS WKWebView shell.
```

- [ ] **Step 2: Run every automated gate**

Run:

```bash
cd app
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Expected: every command exits 0.

- [ ] **Step 3: Run the macOS development and debug-bundle smoke checks**

Run:

```bash
cd app
npm run tauri dev
npm run tauri build -- --debug
```

Expected: complete every item in `docs/testing/macos-smoke.md`. Record the current architecture and macOS version at the bottom of the checklist.

- [ ] **Step 4: Commit the verified foundation**

```bash
git add docs/testing/macos-smoke.md app
git commit -m "docs: verify macOS application foundation"
```

## Phase 0 Completion Gate

Do not begin Phase 1 until:

- `npm ci`, typecheck, unit/component tests, Vite build, browser E2E, Rust test, Clippy, and rustfmt all pass.
- Development and debug `.app` smoke tests pass on the current Mac.
- Browser E2E is not described as packaged-app coverage.
- No SQLite, AI, keychain, or hotel domain code has been added early.
