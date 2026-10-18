import GlobeView from "@/components/GlobeView";

// Phase 1: a full-screen light globe with a small wordmark over it.
export default function Home() {
  return (
    <main className="relative h-full w-full overflow-hidden">
      <GlobeView />

      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5 sm:p-7">
        <div>
          <h1 className="font-serif text-2xl leading-none tracking-tight text-ink sm:text-3xl">
            Global View
          </h1>
          <p className="mt-1.5 max-w-xs text-sm leading-snug text-muted">
            The news each country is reading, and where it leans.
          </p>
        </div>
      </header>

      <p className="pointer-events-none absolute inset-x-0 bottom-5 text-center text-xs text-muted sm:bottom-6">
        Drag to turn the globe
      </p>
    </main>
  );
}
