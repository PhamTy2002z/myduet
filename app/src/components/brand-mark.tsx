import { cn } from "@/lib/utils";

/**
 * The deployment's mark: the same two strokes as `public/icon.svg`, drawn in `currentColor` so it
 * follows the theme instead of carrying the favicon's dark tile.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="6 9 36 32"
      aria-hidden="true"
      className={cn("block shrink-0", className)}
    >
      <path
        d="M6 9 H15 L24.5 33 L21 41 Z"
        fill="currentColor"
        fillOpacity={0.5}
      />
      <path
        d="M33 9 H42 L34 24 H38.5 L21 41 L27 28 H22.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}
