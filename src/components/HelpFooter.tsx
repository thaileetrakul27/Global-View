import type { Society } from "@/lib/data";
import { societyLink } from "@/lib/help";

interface Props {
  name: string;
  society: Society;
}

// Shown at the end of a country's panel when nothing names the country:
// a quiet pointer to its own Red Cross or Red Crescent society.
export default function HelpFooter({ name, society }: Props) {
  const l = societyLink(society, name);
  return (
    <p className="mt-5 border-t border-line pt-3 text-xs leading-snug text-muted">
      No disaster alert, Red Cross appeal or UN response plan names {name} right now. Its own society is the{" "}
      <a
        href={l.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {society.name}
      </a>
      .
    </p>
  );
}
