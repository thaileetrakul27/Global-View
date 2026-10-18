"use client";

import { useEffect, useState } from "react";

export interface Viewport {
  width: number;
  height: number;
  /** True at the md breakpoint and up, where the side panel is used. */
  isDesktop: boolean;
}

const DESKTOP_QUERY = "(min-width: 768px)";

/** Window size and layout mode, updated on resize. Starts empty on the server. */
export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>({ width: 0, height: 0, isDesktop: true });

  useEffect(() => {
    const read = () =>
      setVp({
        width: window.innerWidth,
        height: window.innerHeight,
        isDesktop: window.matchMedia(DESKTOP_QUERY).matches,
      });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  return vp;
}
