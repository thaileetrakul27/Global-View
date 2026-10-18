"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fraction of the viewport height shown when the sheet is collapsed. */
  peek: number;
  children: ReactNode;
}

/** Fraction of the viewport height the sheet covers when fully expanded. */
const FULL = 0.88;
/** Drag distance in px that counts as a deliberate swipe. */
const SWIPE = 60;

// Mobile bottom sheet with two resting positions, peek and full, that the
// user drags between. Dragging down from peek closes it.
export default function BottomSheet({ open, onClose, peek, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<number | null>(null);
  // True once a pointer has moved far enough to count as a drag, so the
  // click the browser fires afterwards does not also toggle the sheet.
  const movedRef = useRef(false);
  const [vh, setVh] = useState(0);

  // Each new opening starts at the peek height. Adjusting state while
  // rendering (rather than in an effect) avoids a flash of the old position.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setExpanded(false);
  }

  useEffect(() => {
    const read = () => setVh(window.innerHeight);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const fullPx = vh * FULL;
  const peekPx = vh * peek;
  const restingY = expanded ? 0 : fullPx - peekPx;
  const y = open ? Math.max(0, restingY + dragY) : fullPx;

  const onPointerDown = (e: React.PointerEvent) => {
    startRef.current = e.clientY;
    movedRef.current = false;
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startRef.current === null) return;
    const dy = e.clientY - startRef.current;
    if (Math.abs(dy) > 5) movedRef.current = true;
    setDragY(dy);
  };
  const onPointerUp = useCallback(() => {
    if (startRef.current === null) return;
    startRef.current = null;
    setDragging(false);
    const dy = dragY;
    setDragY(0);
    if (dy < -SWIPE) setExpanded(true);
    else if (dy > SWIPE) {
      if (expanded) setExpanded(false);
      else onClose();
    }
  }, [dragY, expanded, onClose]);

  return (
    <section
      aria-label="Country"
      aria-hidden={!open}
      inert={!open}
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-line bg-paper shadow-[0_-1px_0_var(--line)]"
      style={{
        height: fullPx || undefined,
        transform: `translateY(${y}px)`,
        transition: dragging ? "none" : "transform 300ms ease-out",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={expanded ? "Collapse panel" : "Expand panel"}
        aria-expanded={expanded}
        onClick={() => {
          if (movedRef.current) return; // a drag, not a tap
          setExpanded((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex cursor-grab touch-none justify-center py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div className="h-1.5 w-10 rounded-full bg-line" />
      </div>
      <div className={`min-h-0 flex-1 ${expanded ? "overflow-y-auto" : "overflow-hidden"}`}>
        {children}
      </div>
    </section>
  );
}
