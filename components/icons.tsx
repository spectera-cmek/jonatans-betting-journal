// Icon set. UI icons come from lucide-react (the same library the reference
// design uses); the sport glyphs are hand-drawn in the same 24×24 / stroke-1.8
// language because lucide has no ball sports.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Award,
  BookOpen,
  Calendar,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  Coins,
  Download,
  Ellipsis,
  Eye,
  Filter,
  Flag,
  Flame,
  Gamepad2,
  HandFist,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  List,
  Menu,
  Minus,
  Pencil,
  Percent,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Settings,
  Sparkles,
  Target,
  Ticket,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Trash2,
  Trophy,
  Upload,
  User,
  Wallet,
  Wrench,
  X,
  Zap,
} from "lucide-react";

/**
 * Renders an icon at a given pixel size. Every call site passes an entry from
 * IC (or SPORT_IC) as `p`, so swapping the underlying icon set only ever
 * touches this file.
 */
export function I({ p: Icon, size = 17 }: { p: LucideIcon; size?: number }) {
  return <Icon size={size} strokeWidth={1.8} absoluteStrokeWidth />;
}

/**
 * The app logo glyph: three ascending bars, the same shape as app/icon.svg and
 * therefore the PWA icons. Lives outside IC so it never gets picked up as a
 * plain UI icon somewhere.
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

export const IC = {
  // navigation
  dashboard: LayoutDashboard,
  ticket: Ticket,
  grid: LayoutGrid,
  list: List,
  chart: ChartLine,
  book: BookOpen,
  gear: Settings,
  calendar: Calendar,
  trophy: Trophy,
  spark: Sparkles,
  percent: Percent,
  wrench: Wrench,
  menu: Ellipsis,
  activity: Activity,

  // actions
  plus: Plus,
  search: Search,
  x: X,
  check: Check,
  minus: Minus,
  edit: Pencil,
  trash: Trash2,
  refresh: RefreshCw,
  download: Download,
  upload: Upload,
  filter: Filter,
  eye: Eye,
  user: User,

  // metrics & status
  trendUp: TrendingUp,
  trendDown: TrendingDown,
  coins: Coins,
  target: Target,
  bars: ChartColumn,
  pie: ChartPie,
  zap: Zap,
  flame: Flame,
  scale: Scale,
  layers: Layers,
  wallet: Wallet,
  award: Award,
  clock: Clock,
  alert: TriangleAlert,
  helpCircle: CircleHelp,
  checkCircle: CircleCheck,
  closeCircle: CircleX,
  minusCircle: CircleMinus,
  arrowUpDown: ArrowUpDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
} satisfies Record<string, LucideIcon>;

/**
 * Wraps hand-drawn SVG children in a lucide-compatible component.
 *
 * Reproduces lucide's `absoluteStrokeWidth`: the viewBox is a fixed 24 units, so
 * a raw stroke-width of 1.8 renders at only 1.05px once the icon is scaled down
 * to 14px. Scaling it by 24/size keeps the line weight visually identical to the
 * lucide icons these sit next to.
 */
function glyph(children: React.ReactNode): LucideIcon {
  const Glyph = ({ size = 24, strokeWidth = 1.8, absoluteStrokeWidth, ...rest }: any) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={absoluteStrokeWidth === false ? strokeWidth : (Number(strokeWidth) * 24) / Number(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
  return Glyph as unknown as LucideIcon;
}

/**
 * Sport glyphs, keyed by the canonical sport names in lib/constants.ts (English)
 * with the Swedish aliases that also occur in imported rows. Ball sports are
 * drawn by hand — lucide has none — the rest reuse a lucide icon that reads
 * unambiguously.
 */
const FOOTBALL = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.4l3.9 2.85-1.49 4.6H9.59l-1.49-4.6L12 7.4z" />
    <path d="M12 3v4.4M3.4 9.6l4.7.65M20.6 9.6l-4.7.65M6.5 19.4l3.09-4.55M17.5 19.4l-3.09-4.55" />
  </>
);
const BASKETBALL = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18M3 12h18" />
    <path d="M5.6 5.6c2.6 2.1 4.1 4.6 4.1 6.4s-1.5 4.3-4.1 6.4M18.4 5.6c-2.6 2.1-4.1 4.6-4.1 6.4s1.5 4.3 4.1 6.4" />
  </>
);
const TENNIS = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.2 5.8c3.3 2.4 4.8 6.1 3.6 10.4M18.8 5.8c-3.3 2.4-4.8 6.1-3.6 10.4" />
  </>
);
const HOCKEY = glyph(
  <>
    <path d="M4.5 3.5v9.5a3 3 0 0 0 3 3h7" />
    <path d="M14.5 13.6l5 2.4-5 2.4z" />
    <ellipse cx="8" cy="20" rx="3.4" ry="1.5" />
  </>
);
const BASEBALL = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M6.4 5.6c1.9 1.8 2.9 4 2.9 6.4s-1 4.6-2.9 6.4M17.6 5.6c-1.9 1.8-2.9 4-2.9 6.4s1 4.6 2.9 6.4" />
    <path d="M8.1 8.4l1.5.5M8.1 15.6l1.5-.5M15.9 8.4l-1.5.5M15.9 15.6l-1.5-.5" />
  </>
);
const AM_FOOTBALL = glyph(
  <>
    <path d="M4.4 19.6c-1.8-4.6-.6-10.8 2.9-14.3S16 1.6 19.6 4.4c1.8 4.6.6 10.8-2.9 14.3S8 22.4 4.4 19.6z" />
    <path d="M9.2 14.8l5.6-5.6M10.6 12.4l1.5 1.5M12.4 10.6l1.5 1.5" />
  </>
);
const HANDBALL = glyph(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3c-2 2.6-3 5.6-3 9s1 6.4 3 9M12 3c2 2.6 3 5.6 3 9s-1 6.4-3 9" />
    <path d="M3.4 9.5c2.7 1 5.6 1.5 8.6 1.5s5.9-.5 8.6-1.5" />
  </>
);
const HORSE = glyph(
  <>
    <path d="M5 20.5v-5.2a6.5 6.5 0 0 1 6.5-6.5h1.2l3.4-4 2.9 1.2-1.2 3.9 2.2 2.8-2.9 2.9v4.9" />
    <path d="M9.4 20.5v-4.3" />
    <circle cx="17.1" cy="6.4" r=".8" fill="currentColor" stroke="none" />
  </>
);
const CRICKET = glyph(
  <>
    <path d="M14.8 3.6l5.6 5.6-8.4 8.4-5.6-5.6z" />
    <path d="M6.4 12l-2.8 2.8a2 2 0 0 0 0 2.8l2.8 2.8a2 2 0 0 0 2.8 0L12 17.6" />
    <circle cx="19" cy="18.5" r="2.2" />
  </>
);

export const SPORT_IC: Record<string, LucideIcon> = {
  // canonical (lib/constants.ts)
  football: FOOTBALL,
  "american football": AM_FOOTBALL,
  tennis: TENNIS,
  basketball: BASKETBALL,
  "ice hockey": HOCKEY,
  baseball: BASEBALL,
  mma: HandFist,
  boxing: HandFist,
  esports: Gamepad2,
  "horse racing": HORSE,
  golf: Flag,
  cricket: CRICKET,
  other: CircleDot,
  // Swedish aliases seen in imported rows
  fotboll: FOOTBALL,
  basket: BASKETBALL,
  ishockey: HOCKEY,
  hockey: HOCKEY,
  baseboll: BASEBALL,
  handboll: HANDBALL,
  boxning: HandFist,
  esport: Gamepad2,
  trav: HORSE,
  travsport: HORSE,
  bordtennis: TENNIS,
  padel: TENNIS,
  övrigt: CircleDot,
};

/** Pick a sport glyph by (loose) name; falls back to a neutral marker. */
const SPORT_KEYS = Object.keys(SPORT_IC).sort((a, b) => b.length - a.length);

export function sportIcon(sport?: string | null): LucideIcon {
  if (!sport) return SPORT_IC.other;
  const key = sport.trim().toLowerCase();
  for (const k of SPORT_KEYS) {
    if (key === k || key.startsWith(k)) return SPORT_IC[k];
  }
  if (/^(cs|dota|lol|league of legends|valorant|rocket)/.test(key)) return SPORT_IC.esports;
  if (key.startsWith("ufc")) return SPORT_IC.mma;
  return SPORT_IC.other;
}
