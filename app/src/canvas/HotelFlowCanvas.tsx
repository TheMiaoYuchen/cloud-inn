import { Application, Container, Sprite, Texture } from "pixi.js";
import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  FlowProjectionEvent,
  FlowProjectionKind,
  FlowProjectionSnapshot,
} from "../domain/flows/flowProjection";
import {
  clampViewportTransform,
  fitViewport,
  initialViewportTransform,
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

type PooledSprite = {
  sprite: Sprite;
  event: FlowProjectionEvent;
  active: boolean;
  elapsedMs: number;
};

function configureSprite(sprite: Sprite, event: FlowProjectionEvent): void {
  sprite.anchor.set(0.5);
  sprite.position.set(event.x, event.y);
  sprite.tint = FLOW_COLORS[event.kind];
  const markerSize = Math.min(12, 4 + Math.log2(event.count + 1));
  sprite.width = markerSize;
  sprite.height = markerSize;
  sprite.eventMode = "none";
}

function animateSprite(pooled: PooledSprite, deltaMs: number): void {
  if (!pooled.active) return;
  pooled.elapsedMs = (pooled.elapsedMs + Math.max(0, deltaMs)) % 2_000;
  const phase = pooled.elapsedMs <= 1_000
    ? pooled.elapsedMs / 1_000
    : (2_000 - pooled.elapsedMs) / 1_000;
  pooled.sprite.position.set(
    pooled.event.x + (pooled.event.targetX - pooled.event.x) * phase,
    pooled.event.y + (pooled.event.targetY - pooled.event.y) * phase,
  );
}

export function HotelFlowCanvas({
  snapshot,
  initializeForTest,
  worldLayerRef,
}: {
  snapshot: FlowProjectionSnapshot;
  initializeForTest?: (application: Application) => Promise<void>;
  worldLayerRef?: RefObject<HTMLElement | null>;
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
    let animateCallback: ((ticker: { deltaMS: number }) => void) | undefined;
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
    const applyWorldTransform = (
      container: Container,
      transform: ViewportTransform,
    ) => {
      container.position.set(transform.x, transform.y);
      container.scale.set(transform.scale);
      const layer = worldLayerRef?.current;
      if (!layer) return;
      layer.style.width = `${snapshotRef.current.width}px`;
      layer.style.height = `${snapshotRef.current.height}px`;
      layer.style.transformOrigin = "0 0";
      layer.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
      layer.dataset.viewportTransform = `${transform.x},${transform.y},${transform.scale}`;
    };

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
      const viewport = { width: size.width, height: size.height };
      const transform = initialViewportTransform(viewport, snapshotRef.current);
      applyWorldTransform(container, transform);

      const sprites = snapshotRef.current.events.map((event): PooledSprite => {
        const sprite = new Sprite(Texture.WHITE);
        configureSprite(sprite, event);
        sprite.visible = pointInViewport(event, transform, viewport, 12);
        container.addChild(sprite);
        return { sprite, event, active: true, elapsedMs: 0 };
      });
      runtimeRef.current = { container, sprites, transform, viewport };
      let animationTick = 0;
      let animationDistance = 0;
      host.dataset.flowAnimationTick = "0";
      host.dataset.flowAnimationDistance = "0.00";
      host.dataset.flowAnimationSample = sprites[0]
        ? `${sprites[0].sprite.x.toFixed(2)},${sprites[0].sprite.y.toFixed(2)}`
        : "none";
      animateCallback = (ticker: { deltaMS: number }) => {
        const runtime = runtimeRef.current;
        if (!runtime) return;
        for (const pooled of runtime.sprites) {
          const beforeX = pooled.sprite.x;
          const beforeY = pooled.sprite.y;
          animateSprite(pooled, ticker.deltaMS);
          if (pooled.active) {
            animationDistance += Math.hypot(
              pooled.sprite.x - beforeX,
              pooled.sprite.y - beforeY,
            );
          }
          pooled.sprite.visible = pooled.active && pointInViewport(
            pooled.sprite,
            runtime.transform,
            runtime.viewport,
            12,
          );
        }
        animationTick += 1;
        host.dataset.flowAnimationTick = String(animationTick);
        host.dataset.flowAnimationDistance = animationDistance.toFixed(2);
        const sample = runtime.sprites.find(({ active }) => active)?.sprite;
        host.dataset.flowAnimationSample = sample
          ? `${sample.x.toFixed(2)},${sample.y.toFixed(2)}`
          : "none";
      };
      app.ticker.add(animateCallback);
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
          const runtime = runtimeRef.current;
          runtime.viewport = { width: size.width, height: size.height };
          runtime.transform = clampViewportTransform(
            runtime.transform,
            runtime.viewport,
            { width: snapshotRef.current.width, height: snapshotRef.current.height },
          );
          applyWorldTransform(runtime.container, runtime.transform);
          for (const pooled of runtime.sprites) {
            pooled.sprite.visible = pooled.active && pointInViewport(
              pooled.sprite,
              runtime.transform,
              runtime.viewport,
              12,
            );
          }
        });
    observer?.observe(host);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (application && animateCallback) application.ticker.remove(animateCallback);
      runtimeRef.current = null;
      if (application) destroy(application);
    };
  }, [initializeForTest, worldLayerRef]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    snapshot.events.forEach((event, index) => {
      let pooled = runtime.sprites[index];
      if (!pooled) {
        const sprite = new Sprite(Texture.WHITE);
        runtime.container.addChild(sprite);
        pooled = { sprite, event, active: true, elapsedMs: 0 };
        runtime.sprites.push(pooled);
      }
      if (pooled.event.id !== event.id) pooled.elapsedMs = 0;
      pooled.event = event;
      pooled.active = true;
      configureSprite(pooled.sprite, event);
      animateSprite(pooled, 0);
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
    const layer = worldLayerRef?.current;
    if (layer) {
      layer.style.width = `${snapshot.width}px`;
      layer.style.height = `${snapshot.height}px`;
      layer.style.transformOrigin = "0 0";
      layer.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
      layer.dataset.viewportTransform = `${transform.x},${transform.y},${transform.scale}`;
    }
    for (const { active, sprite } of runtime.sprites) {
      sprite.visible = active && pointInViewport(sprite, transform, runtime.viewport, 12);
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
