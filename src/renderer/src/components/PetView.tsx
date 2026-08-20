import { useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, PointerEvent } from "react";
import { i18n, resolveLanguage } from "../../../shared/i18n";
import type { PetCursorMotion, PetState, SpeechBubble } from "../../../shared/types";
import { getPetAsset, getPetAssetVariantCount } from "../assets";
import { useNow, useSnapshot } from "../hooks";
import { pointInElementHitbox } from "../petHitbox";

type DragRef = {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const CONTINUOUS_ASSET_STATES = new Set<PetState>(["idle", "focusGuard"]);
const CONTINUOUS_ASSET_ROTATION_MS = 15 * 60 * 1000;
const DRAG_START_DISTANCE_PX = 10;
const PET_BUTTON_SELECTOR = ".pet-button";
const BUBBLE_INTERACTIVE_SELECTOR = ".speech-bubble";

function randomVariant(count: number, previous?: number): number {
  if (count <= 1) return 0;
  let next = Math.floor(Math.random() * count);
  if (previous !== undefined && next === previous) {
    next = (next + 1) % count;
  }
  return next;
}

function formatFocusCountdown(endsAt: number | null, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil(((endsAt ?? now) - now) / 1000));
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function PetView(): JSX.Element {
  const snapshot = useSnapshot();
  const now = useNow(1000);
  const [bubble, setBubble] = useState<SpeechBubble | null>(null);
  const [assetVariant, setAssetVariant] = useState(0);
  const [assetReplayKey, setAssetReplayKey] = useState(0);
  const [stateSignal, setStateSignal] = useState(0);
  const [cursorMotion, setCursorMotion] = useState<PetCursorMotion>({
    x: 0,
    y: 0,
    distance: Number.POSITIVE_INFINITY,
    near: false
  });
  const [dragging, setDragging] = useState(false);
  const [dropBounce, setDropBounce] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  const dragRef = useRef<DragRef | null>(null);
  const mouseInteractiveRef = useRef<boolean | null>(null);
  const lastMousePointRef = useRef<{ x: number; y: number } | null>(null);
  const bubbleVisibleRef = useRef(false);
  const labels = i18n(resolveLanguage(snapshot.settings.language)).settings;

  useEffect(() => {
    const offBubble = window.pawpal.onShowBubble(setBubble);
    const offHide = window.pawpal.onHideBubble(() => setBubble(null));
    const offPetState = window.pawpal.onPetState(() => setStateSignal((current) => current + 1));
    const offCursorMotion = window.pawpal.onPetCursorMotion(setCursorMotion);
    return () => {
      offBubble();
      offHide();
      offPetState();
      offCursorMotion();
    };
  }, []);

  const state = snapshot.petState;
  const altText = `Domi ${state}`;
  const facingClass = snapshot.petFacing === "left" ? "facing-left" : "facing-right";
  const appearanceId = snapshot.settings.petAppearanceId;
  const customAppearance = snapshot.settings.customPetAppearance;
  const asset = getPetAsset(appearanceId, state, assetVariant, assetReplayKey, customAppearance);

  function finishPointerDrag(clicked: boolean): void {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.dragging) {
      window.pawpal.petDragStop();
      setDragging(false);
      setDropBounce(true);
      window.setTimeout(() => setDropBounce(false), 520);
      return;
    }
    if (clicked) {
      setHeartBurst((current) => current + 1);
      window.pawpal.petClicked();
    }
  }

  function setMouseInteractive(interactive: boolean): void {
    if (mouseInteractiveRef.current === interactive) return;
    mouseInteractiveRef.current = interactive;
    window.pawpal.setMouseInteractive(interactive);
  }

  function updateMouseInteractivity(point: { x: number; y: number } | null): void {
    if (dragRef.current) {
      setMouseInteractive(true);
      return;
    }

    if (!point) {
      setMouseInteractive(false);
      return;
    }

    const target = document.elementFromPoint(point.x, point.y);
    if (!(target instanceof Element)) {
      setMouseInteractive(false);
      return;
    }

    const petButton = target.closest(PET_BUTTON_SELECTOR);
    const isOnPet = petButton ? pointInElementHitbox(point, petButton) : false;
    const isOnBubble =
      bubbleVisibleRef.current && Boolean(target.closest(BUBBLE_INTERACTIVE_SELECTOR));

    setMouseInteractive(isOnPet || isOnBubble);
  }

  useEffect(() => {
    const variantCount = getPetAssetVariantCount(appearanceId, state, customAppearance);
    setAssetVariant(randomVariant(variantCount));
    setAssetReplayKey(0);
    if (!CONTINUOUS_ASSET_STATES.has(state) || variantCount <= 1) return;
    const timer = window.setInterval(() => {
      setAssetVariant((current) => randomVariant(variantCount, current));
    }, CONTINUOUS_ASSET_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [appearanceId, customAppearance, state, stateSignal]);

  useEffect(() => {
    if (!asset.replayIntervalMs) return;
    const timer = window.setInterval(() => {
      setAssetReplayKey((current) => current + 1);
    }, asset.replayIntervalMs);
    return () => window.clearInterval(timer);
  }, [asset.replayIntervalMs]);

  useEffect(() => {
    const cancelActiveDrag = (): void => finishPointerDrag(false);
    const trackMouse = (event: MouseEvent): void => {
      const point = { x: event.clientX, y: event.clientY };
      lastMousePointRef.current = point;
      updateMouseInteractivity(point);
    };
    const clearMouse = (): void => {
      lastMousePointRef.current = null;
      updateMouseInteractivity(null);
    };

    setMouseInteractive(false);
    window.addEventListener("mousemove", trackMouse);
    window.addEventListener("mouseleave", clearMouse);
    window.addEventListener("pointerup", cancelActiveDrag);
    window.addEventListener("pointercancel", cancelActiveDrag);
    window.addEventListener("blur", cancelActiveDrag);
    return () => {
      window.removeEventListener("mousemove", trackMouse);
      window.removeEventListener("mouseleave", clearMouse);
      window.removeEventListener("pointerup", cancelActiveDrag);
      window.removeEventListener("pointercancel", cancelActiveDrag);
      window.removeEventListener("blur", cancelActiveDrag);
      window.pawpal.setMouseInteractive(true);
    };
  }, []);

  useEffect(() => {
    bubbleVisibleRef.current = Boolean(bubble);
    updateMouseInteractivity(lastMousePointRef.current);
  }, [bubble]);

  function startPointer(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
  }

  function movePointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance > DRAG_START_DISTANCE_PX) {
      drag.dragging = true;
      setDragging(true);
      window.pawpal.petDragStart({ offsetX: drag.startX, offsetY: drag.startY });
    }
  }

  function stopPointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const shouldReleaseCapture = event.currentTarget.hasPointerCapture(event.pointerId);
    finishPointerDrag(true);
    if (shouldReleaseCapture) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function cancelPointer(event: PointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    finishPointerDrag(false);
  }

  return (
    <main
      className="pet-shell"
      aria-label="Domi desktop pet"
      onContextMenu={(event) => {
        event.preventDefault();
        window.pawpal.petContextMenu();
      }}
    >
      {bubble ? (
        <section className="speech-bubble">
          <p>{bubble.message}</p>
          {bubble.actions?.length ? (
            <div className="bubble-actions">
              {bubble.actions.map((action) => (
                <button
                  className={`bubble-button ${action.kind ?? "secondary"}`}
                  key={action.id}
                  onClick={() => window.pawpal.bubbleAction(action.id)}
                  type="button"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {snapshot.focusActive ? (
        <div className="focus-badge">
          <span>{labels.focus}</span>
          <strong>{formatFocusCountdown(snapshot.timers.focusEndsAt, now)}</strong>
        </div>
      ) : null}

      <button
        className={`pet-button state-${state} ${facingClass} ${
          asset.isPlaceholder ? "placeholder-asset" : ""
        }${cursorMotion.near ? " is-cursor-near" : ""}${dragging ? " is-dragging" : ""}${
          dropBounce ? " is-dropping" : ""
        }`}
        style={
          {
            "--look-x": `${cursorMotion.x * 5}px`,
            "--look-y": `${cursorMotion.y * 3}px`,
            "--look-rotate": `${cursorMotion.x * 2.6}deg`
          } as CSSProperties
        }
        onPointerCancel={cancelPointer}
        onPointerDown={startPointer}
        onLostPointerCapture={() => finishPointerDrag(false)}
        onPointerMove={movePointer}
        onPointerUp={stopPointer}
        type="button"
      >
        <span className="pet-look">
          {asset.mediaType === "video" ? (
            <video
              className="pet-media"
              draggable={false}
              src={asset.src}
              aria-label={altText}
              autoPlay
              loop
              muted
              playsInline
            />
          ) : (
            <img className="pet-media" draggable={false} src={asset.src} alt={altText} />
          )}
        </span>
      </button>
      <span className="heart-burst" key={heartBurst} aria-hidden="true">
        {heartBurst > 0
          ? ["❤", "❤", "❤"].map((heart, index) => (
              <i
                key={`${heartBurst}-${index}`}
                style={
                  {
                    "--heart-left": `${22 + index * 16}px`,
                    "--heart-x": `${(index - 1) * 13}px`
                  } as CSSProperties
                }
              >
                {heart}
              </i>
            ))
          : null}
      </span>
    </main>
  );
}
