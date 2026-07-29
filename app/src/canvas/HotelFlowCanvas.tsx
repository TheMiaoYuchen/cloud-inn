import { Application, Container, Sprite, Texture } from "pixi.js";
import { useEffect, useRef, useState } from "react";
import type {
  FlowProjectionEvent,
  FlowProjectionKind,
  FlowProjectionSnapshot,
} from "../domain/flows/flowProjection";
import {
  clampViewportTransform,
  fitViewport,
  pointInViewport,
  type ViewportBounds,
  type ViewportTransform,
} from "./viewport";

const FLOW_COLORS: Record<FlowProjectionKind, number> = {
  guest: 0xf0dfbe,
  staff: 0x88c0a7,
  luggage: 0xc9aa75,
  cleaning: 0x8db5d7,
  "room-service": 0xe49b73,
};

type PooledSprite = { sprite: Sprite; event: FlowProjectionEvent; active: boolean };

function configureSprite(sprite: Sprite, event: FlowProjectionEvent): void {
  sprite.anchor.set(0.5);
  sprite.position.set(event.x, event.y);
  sprite.tint = FLOW_COLORS[event.kind];
  const markerSize = Math.min(12, 4 + Math.log2(event.count + 1));
  sprite.width = markerSize;
  sprite.height = markerSize;
  sprite.eventMode = "none";
}

export function HotelFlowCanvas({
  snapshot,
  initializeForTest,
}: {
  snapshot: FlowProjectionSnapshot;
  initializeForTest?: (application: Application) => Promise<void>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<{
    container: Container;
    sprites: PooledSprite[];
    transform: ViewportTransform;
    viewport: ViewportBounds;
  } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let application: Application | undefined;
    let destroyed = false;
    const destroy = (target: Application) => {
      if (destroyed) return;
      destroyed = true;
      try {
        target.destroy(true, { children: true });
      } catch (error) {
        console.error("Failed to clean up hotel flow canvas", error);
      }
    };
    const hostSize = () => fitViewport(
      host.clientWidth || snapshotRef.current.width,
      host.clientHeight || snapshotRef.current.height,
      window.devicePixelRatio,
    );

    const start = async () => {
      const app = new Application();
      application = app;
      const size = hostSize();
      try {
        if (initializeForTest) {
          await initializeForTest(app);
        } else {
          await app.init({
            width: size.width,
            height: size.height,
            resolution: size.resolution,
            autoDensity: true,
            antialias: false,
            backgroundAlpha: 0,
          });
        }
      } catch (error) {
        console.error("Failed to initialize hotel flow canvas", error);
        destroy(app);
        if (!cancelled) setFailed(true);
        return;
      }

      if (cancelled) {
        destroy(app);
        return;
      }

      const container = new Container();
      app.stage.addChild(container);
      const transform = { x: 0, y: 0, scale: 1 };
      const viewport = { width: size.width, height: size.height };
      container.position.set(transform.x, transform.y);
      container.scale.set(transform.scale);

      const sprites = snapshotRef.current.events.map((event): PooledSprite => {
        const sprite = new Sprite(Texture.WHITE);
        configureSprite(sprite, event);
        sprite.visible = pointInViewport(event, transform, viewport, 12);
        container.addChild(sprite);
        return { sprite, event, active: true };
      });
      runtimeRef.current = { container, sprites, transform, viewport };
      app.canvas.dataset.testid = "hotel-flow-canvas";
      app.canvas.setAttribute("aria-hidden", "true");
      host.appendChild(app.canvas);
    };

    void start();

    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (!application || !runtimeRef.current || destroyed) return;
          const size = hostSize();
          application.renderer.resize(size.width, size.height);
          runtimeRef.current.viewport = { width: size.width, height: size.height };
        });
    observer?.observe(host);

    return () => {
      cancelled = true;
      observer?.disconnect();
      runtimeRef.current = null;
      if (application) destroy(application);
    };
  }, [initializeForTest]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    snapshot.events.forEach((event, index) => {
      let pooled = runtime.sprites[index];
      if (!pooled) {
        const sprite = new Sprite(Texture.WHITE);
        runtime.container.addChild(sprite);
        pooled = { sprite, event, active: true };
        runtime.sprites.push(pooled);
      }
      pooled.event = event;
      pooled.active = true;
      configureSprite(pooled.sprite, event);
      pooled.sprite.visible = pointInViewport(event, runtime.transform, runtime.viewport, 12);
    });
    for (let index = snapshot.events.length; index < runtime.sprites.length; index += 1) {
      runtime.sprites[index].active = false;
      runtime.sprites[index].sprite.visible = false;
    }
  }, [snapshot]);

  const updateViewport = (next: ViewportTransform) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const transform = clampViewportTransform(
      next,
      runtime.viewport,
      { width: snapshot.width, height: snapshot.height },
    );
    runtime.transform = transform;
    runtime.container.position.set(transform.x, transform.y);
    runtime.container.scale.set(transform.scale);
    for (const { active, event, sprite } of runtime.sprites) {
      sprite.visible = active && pointInViewport(event, transform, runtime.viewport, 12);
    }
  };

  const dragging = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  return (
    <div
      ref={hostRef}
      data-testid="hotel-flow-host"
      data-flow-sprite-count={snapshot.events.length}
      aria-label="本层聚合流动图"
      onWheel={(event) => {
        event.preventDefault();
        const runtime = runtimeRef.current;
        if (!runtime) return;
        const factor = event.deltaY < 0 ? 1.12 : 0.89;
        updateViewport({ ...runtime.transform, scale: runtime.transform.scale * factor });
      }}
      onPointerDown={(event) => {
        dragging.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragging.current;
        const runtime = runtimeRef.current;
        if (!drag || !runtime || drag.pointerId !== event.pointerId) return;
        updateViewport({
          ...runtime.transform,
          x: runtime.transform.x + event.clientX - drag.x,
          y: runtime.transform.y + event.clientY - drag.y,
        });
        dragging.current = { pointerId: drag.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => { dragging.current = null; }}
      onPointerCancel={() => { dragging.current = null; }}
      style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none" }}
    >
      {failed ? (
        <div
          role="status"
          style={{ position: "absolute", inset: 8, padding: 8, background: "rgba(24,35,33,.82)" }}
        >
          <strong>流动图暂不可用</strong>
          <span>{`本层聚合流动 ${snapshot.events.length} 组`}</span>
        </div>
      ) : null}
    </div>
  );
}
