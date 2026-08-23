/**
 * The app logo glyph: three ascending bars, the same shape as app/icon.svg and
 * therefore the PWA icons. Lives outside IC so it never gets picked up as a
 * plain UI icon somewhere.
 *
 * Its own module because /login and /register render nothing but this — and
 * importing it from components/icons.tsx dragged in the IC/SPORT_IC tables and,
 * with them, the whole ~36 kB lucide icon chunk.
 */
export function BrandMark({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth={3.2} strokeLinecap="round">
        <path d="M6.5 17.3V14.3" />
        <path d="M12 17.3V10.7" />
        <path d="M17.5 17.3V6.7" />
      </g>
    </svg>
  );
}
