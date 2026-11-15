// The one list of destinations. The side panel, the phone's bottom tabs and
// "Mer" sheet, and the quick search (Ctrl/⌘K) all read it, so a page added here
// shows up everywhere at once.

import type { LucideIcon } from "lucide-react";
import { IC, SPORT_IC } from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** One line shown in the phone sheet and matched by the quick search. */
  desc: string;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "journal",
    label: "Journal",
    items: [
      { href: "/", label: "Översikt", icon: IC.dashboard, desc: "Resultat, öppna spel och form" },
      { href: "/bets", label: "Bets", icon: IC.ticket, desc: "Alla spel, sök och filter" },
      { href: "/calendar", label: "Kalender", icon: IC.calendar, desc: "Dag för dag" },
      { href: "/rattning", label: "Rättning", icon: IC.zap, desc: "Rätta öppna spel" },
    ],
  },
  {
    key: "analys",
    label: "Analys",
    items: [
      { href: "/analytics", label: "Analys", icon: IC.chart, desc: "ROI, CLV och fördelningar" },
      { href: "/insights", label: "Insikter", icon: IC.spark, desc: "Mönster, form och edge" },
    ],
  },
  {
    key: "modeller",
    label: "Modeller",
    items: [
      { href: "/skott", label: "Skottmodell", icon: IC.bars, desc: "Skott och hörnor" },
      { href: "/cs2", label: "CS2", icon: IC.gamepad, desc: "Lag, spelare och props" },
      { href: "/nba", label: "NBA", icon: SPORT_IC.basketball, desc: "Simulering mot marknaden" },
      { href: "/vm2026", label: "VM 2026", icon: IC.trophy, desc: "Turneringsöversikt" },
    ],
  },
  {
    key: "verktyg",
    label: "Verktyg",
    items: [
      { href: "/fairodds", label: "Fair odds", icon: IC.percent, desc: "Räkna ut rättvist odds" },
      { href: "/verktyg", label: "Verktyg", icon: IC.wrench, desc: "Hedge, cashout och Kelly" },
    ],
  },
];

/** Pinned to the foot of the side panel, last in the phone sheet. */
export const SETTINGS_NAV: NavItem = {
  href: "/settings",
  label: "Inställningar",
  icon: IC.gear,
  desc: "Konto och konfiguration",
};

export const ALL_NAV: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_NAV];

/** The four destinations that get a bottom tab on phones; the rest sit under "Mer". */
const TAB_HREFS = ["/", "/bets", "/calendar", "/analytics"];
export const MOBILE_TABS: NavItem[] = TAB_HREFS.map((h) => ALL_NAV.find((n) => n.href === h)!);

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
