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
      const size = fitViewport(
        host.clientWidth,
        host.clientHeight,
        window.devicePixelRatio,
      );
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

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (!app) return;
            const size = fitViewport(
              host.clientWidth,
              host.clientHeight,
              window.devicePixelRatio,
            );
            app.renderer.resize(size.width, size.height);
          });
    observer?.observe(host);

    return () => {
      cancelled = true;
      observer?.disconnect();
      app?.destroy(true, { children: true });
    };
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="pixi-host"
      style={{ width: "100%", height: 560 }}
    />
  );
}
