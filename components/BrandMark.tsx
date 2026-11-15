/**
 * The app logo glyph: three rising bars, square-ended — the same shape as
 * app/icon.svg and therefore the PWA icons. It draws in currentColor; the amber
 * tile behind it comes from the `.mark` wrapper. Lives outside IC so it never
 * gets picked up as a plain UI icon somewhere.
 *
 * Its own module because /login and /register render nothing but this — and
 * importing it from components/icons.tsx dragged in the IC/SPORT_IC tables and,
 * with them, the whole ~36 kB lucide icon chunk.
 */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2" y="9" width="3" height="5" />
      <rect x="6.5" y="6" width="3" height="8" />
      <rect x="11" y="2" width="3" height="12" />
    </svg>
  );
}
