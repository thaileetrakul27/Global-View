import type { DisasterType, Severity } from "@/lib/data";
import { DISASTER_META, SEVERITY_LABEL } from "@/lib/disasterMeta";

interface IconProps {
  type: DisasterType;
  /** Pixel size of the square icon. */
  size?: number;
  /** Stroke colour; the type's own colour by default. */
  color?: string;
  className?: string;
  /** Spoken name. Without one the icon is decorative and hidden from screen readers. */
  title?: string;
}

// The hazard's line icon from DISASTER_META, drawn as a 2 px stroke so it
// matches the markers on the globe.
export default function DisasterIcon({ type, size = 20, color, className, title }: IconProps) {
  const meta = DISASTER_META[type];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? meta.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={meta.icon} />
    </svg>
  );
}

const TONE: Record<Severity, string> = {
  3: "border-red-200 bg-red-50 text-red-800",
  2: "border-amber-200 bg-amber-50 text-amber-800",
  1: "border-line bg-paper text-muted",
};

// Small pill with the severity in words ("Severe"), tinted red, amber or grey.
export function SeverityChip({ severity, className = "" }: { severity: Severity; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${TONE[severity]} ${className}`}>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}
