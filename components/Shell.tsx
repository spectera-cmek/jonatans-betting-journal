"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { I, IC, BrandMark } from "./icons";
import type { LucideIcon } from "lucide-react";
import { GlobalActions } from "./GlobalActions";
import { useMetrics } from "@/lib/useData";
import { krShort } from "@/lib/format";

const PRIMARY_NAV = [
  { href: "/", label: "Översikt", icon: IC.dashboard },
  { href: "/bets", label: "Bets", icon: IC.ticket },
  { href: "/calendar", label: "Kalender", icon: IC.calendar },
  { href: "/analytics", label: "Analys", icon: IC.chart },
];

const SECONDARY_NAV = [
  { href: "/vm2026", label: "VM 2026", icon: IC.trophy },
  { href: "/insights", label: "Insikter", icon: IC.spark },
  { href: "/ev", label: "Oddsjämförelse", icon: IC.percent },
  { href: "/skott", label: "Skottmodell", icon: IC.bars },
  { href: "/odds", label: "Värdescanner", icon: IC.search },
  { href: "/fairodds", label: "Fair odds", icon: IC.percent },
  { href: "/verktyg", label: "Verktyg", icon: IC.wrench },
  { href: "/settings", label: "Inställningar", icon: IC.gear },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Bankroll strip: realised P/L, staked-and-open exposure and the count of open
 * bets. Reads the same metrics payload the dashboard uses, so it costs no extra
 * request once that cache is warm. Hidden under 1180px (see globals.css).
 */
function BankrollStrip() {
  const { data } = useMetrics();
  if (!data) return null;
  const unit = data.settings.unitValue ?? 100;
  const profitKr = (data.metrics?.profitUnits ?? 0) * unit;
  const risk = data.openRisk;
  const openKr = risk ? risk.stakeUnits * unit : 0;
  // The count comes from openRisk, not openBets.length: /api/metrics caps that
  // list at the 25 soonest bets for the dashboard ticker.
  const openCount = risk?.bets ?? 0;

  return (
    <div className="ap-bankroll" title="Realiserat resultat, insats i öppna spel och antal öppna spel">
      <div>
        <span style={{ color: "var(--dim2)" }}>
          <I p={IC.wallet} size={15} />
        </span>
        <div>
          <span>Netto</span>
          <strong className={profitKr >= 0 ? "pos" : "neg"}>{krShort(profitKr, true)}</strong>
        </div>
      </div>
      <div>
        <span style={{ color: "var(--dim2)" }}>
          <I p={IC.coins} size={15} />
        </span>
        <div>
          <span>Exponerat</span>
          <strong>{krShort(openKr, false)}</strong>
        </div>
      </div>
      <div>
        <span style={{ color: "var(--dim2)" }}>
          <I p={IC.clock} size={15} />
        </span>
        <div>
          <span>Öppna</span>
          <strong style={{ color: openCount > 0 ? "var(--a-amber)" : "var(--dim)" }}>{openCount}</strong>
        </div>
      </div>
    </div>
  );
}

/** Sticky global header: brand + horizontal nav pills + bankroll + actions. */
export function TopNav({ username }: { username?: string }) {
  const pathname = usePathname();
  return (
    <header className="ap-topnav">
      <div className="ap-topnav-inner">
        <Link href="/" className="ap-brand" aria-label="Betting Översikt">
          <span className="mark" aria-hidden="true">
            <BrandMark />
            <span className="pulse">
              <i />
              <b />
            </span>
          </span>
          <span className="name">
            Betting <em>Översikt</em>
          </span>
        </Link>
        <nav className="ap-nav">
          {PRIMARY_NAV.map((n) => (
            <Link key={n.href} href={n.href} className={"ap-navitem" + (isActive(pathname, n.href) ? " is-active" : "")}>
              <I p={n.icon} size={15} />
              <span>{n.label}</span>
            </Link>
          ))}
          <details key={pathname} className="ap-more">
            <summary className={"ap-navitem" + (SECONDARY_NAV.some((n) => isActive(pathname, n.href)) ? " is-active" : "")}>
              <I p={IC.menu} size={15} />
              <span>Mer</span>
            </summary>
            <div className="ap-more-menu">
              <span className="ap-more-label">Utforska</span>
              {SECONDARY_NAV.map((n) => (
                <Link key={n.href} href={n.href} className={"ap-more-item" + (isActive(pathname, n.href) ? " is-active" : "")}>
                  <I p={n.icon} size={16} />
                  <span>{n.label}</span>
                </Link>
              ))}
            </div>
          </details>
        </nav>
        <div className="ap-topnav-actions">
          <BankrollStrip />
          <GlobalActions />
          <Link href="/settings" className="ap-avatar" title={username ? username[0].toUpperCase() + username.slice(1) : "Konto"}>
            <I p={IC.user} size={15} />
          </Link>
        </div>
      </div>
    </header>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const secondaryActive = SECONDARY_NAV.some((n) => isActive(pathname, n.href));

  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <>
      {moreOpen && (
        <div className="ap-more-sheet-overlay" onClick={() => setMoreOpen(false)}>
          <div className="ap-more-sheet" role="dialog" aria-modal="true" aria-label="Fler sidor" onClick={(e) => e.stopPropagation()}>
            <div className="ap-more-sheet-head">
              <div>
                <span className="ap-label">Betting Översikt</span>
                <div className="ap-card-title" style={{ marginTop: 4 }}>Fler sidor</div>
              </div>
              <button className="ap-close" onClick={() => setMoreOpen(false)} aria-label="Stäng meny">
                <I p={IC.x} size={16} />
              </button>
            </div>
            <div className="ap-more-sheet-grid">
              {SECONDARY_NAV.map((n) => (
                <Link key={n.href} href={n.href} className={"ap-more-sheet-item" + (isActive(pathname, n.href) ? " is-active" : "")}>
                  <span className="ap-more-sheet-icon"><I p={n.icon} size={19} /></span>
                  <span>
                    <strong>{n.label}</strong>
                    <small>{secondaryDescription(n.href)}</small>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="ap-mobnav">
        {PRIMARY_NAV.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(pathname, n.href) ? "is-active" : ""}>
            <I p={n.icon} size={20} /> <span className="ap-mobnav-label">{n.label}</span>
          </Link>
        ))}
        <button className={moreOpen || secondaryActive ? "is-active" : ""} onClick={() => setMoreOpen(true)}>
          <I p={IC.menu} size={20} /> <span className="ap-mobnav-label">Mer</span>
        </button>
      </div>
    </>
  );
}

function secondaryDescription(href: string) {
  if (href === "/vm2026") return "Turneringsöversikt";
  if (href === "/insights") return "Mönster, form och edge";
  if (href === "/ev") return "Böcker över börsen";
  if (href === "/skott") return "Skott och hörnor";
  if (href === "/odds") return "Värde mot konsensus";
  if (href === "/fairodds") return "Räkna ut rättvist odds";
  if (href === "/verktyg") return "Hedge, cashout och Kelly";
  return "Konto och konfiguration";
}

export function Topbar({
  title,
  sub,
  actions,
  icon,
  accent = "emerald",
}: {
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Line icon shown in a tinted chip beside the page title. */
  icon?: LucideIcon;
  accent?: "emerald" | "sky" | "amber" | "purple" | "teal" | "pink";
}) {
  return (
    <div className="ap-top">
      <div className="ap-top-main">
        {icon && (
          <span className={"ap-chip-icon is-" + accent} aria-hidden="true">
            <I p={icon} size={17} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="ap-h1">{title}</div>
          {sub && <div className="ap-sub">{sub}</div>}
        </div>
      </div>
      {actions && <div className="ap-top-actions">{actions}</div>}
    </div>
  );
}
