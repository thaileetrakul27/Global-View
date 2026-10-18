"use client";

import dynamic from "next/dynamic";
import type { GlobeProps } from "./Globe";

// react-globe.gl touches `window` and WebGL on import, so it must only ever
// load in the browser. The placeholder keeps the layout stable meanwhile.
const Globe = dynamic(() => import("./Globe"), {
  ssr: false,
  loading: () => <GlobePlaceholder />,
});

function GlobePlaceholder() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        aria-hidden
        className="aspect-square w-[70vmin] max-w-[560px] animate-pulse rounded-full bg-ocean/70"
      />
    </div>
  );
}

export default function GlobeView(props: GlobeProps) {
  return (
    <div className="absolute inset-0">
      <Globe {...props} />
    </div>
  );
}
