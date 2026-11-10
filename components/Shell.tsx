"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDialog } from "@/lib/useDialog";
import { I, IC, SPORT_IC, BrandMark } from "./icons";
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
  { href: "/rattning", label: "Rättning", icon: IC.zap },
  { href: "/vm2026", label: "VM 2026", icon: IC.trophy },
  { href: "/insights", label: "Insikter", icon: IC.spark },
  { href: "/skott", label: "Skottmodell", icon: IC.bars },
  { href: "/cs2", label: "CS2", icon: IC.gamepad },
  { href: "/nba", label: "NBA", icon: SPORT_IC.basketball },
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
    <div className="ap-bankroll" role="group" aria-label="Bankrulle" title="Realiserat resultat, insats i öppna spel och antal öppna spel">
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
  const moreRef = useRef<HTMLDetailsElement>(null);

  // The "Mer" menu is a <details>: natively it only closes by clicking its own
  // summary again. Close it on Escape (returning focus to the summary) and on
  // any click or focus that lands outside it.
  useEffect(() => {
    const close = (refocus: boolean) => {
      const el = moreRef.current;
      if (!el?.open) return;
      el.open = false;
      if (refocus) el.querySelector("summary")?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(moreRef.current?.contains(document.activeElement) ?? false);
    };
    const onOutside = (e: Event) => {
      if (!moreRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, []);

  return (
    <header className="ap-topnav">
      <a href="#innehall" className="ap-skip">Hoppa till innehållet</a>
      <div className="ap-topnav-inner">
        <Link href="/" className="ap-brand" aria-label="Betting Översikt – till startsidan">
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
        <nav className="ap-nav" aria-label="Huvudmeny">
          {PRIMARY_NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={"ap-navitem" + (isActive(pathname, n.href) ? " is-active" : "")}
              aria-current={isActive(pathname, n.href) ? "page" : undefined}
            >
              <I p={n.icon} size={15} />
              <span>{n.label}</span>
            </Link>
          ))}
          <details key={pathname} ref={moreRef} className="ap-more">
            <summary className={"ap-navitem" + (SECONDARY_NAV.some((n) => isActive(pathname, n.href)) ? " is-active" : "")}>
              <I p={IC.menu} size={15} />
              <span>Mer</span>
            </summary>
            <div className="ap-more-menu">
              <span className="ap-more-label">Utforska</span>
              {SECONDARY_NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={"ap-more-item" + (isActive(pathname, n.href) ? " is-active" : "")}
                  aria-current={isActive(pathname, n.href) ? "page" : undefined}
                >
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
          <Link
            href="/settings"
            className="ap-avatar"
            aria-label={username ? `Inställningar – inloggad som ${username}` : "Inställningar"}
            title={username ? username[0].toUpperCase() + username.slice(1) : "Konto"}
          >
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
  const sheetRef = useDialog<HTMLDivElement>(moreOpen, () => setMoreOpen(false));

  return (
    <>
      {moreOpen && (
        <div className="ap-more-sheet-overlay" onClick={() => setMoreOpen(false)}>
          <div ref={sheetRef} tabIndex={-1} className="ap-more-sheet" role="dialog" aria-modal="true" aria-label="Fler sidor" onClick={(e) => e.stopPropagation()}>
            <div className="ap-more-sheet-head">
              <div>
                <span className="ap-label" style={{ display: "block" }}>Betting Översikt</span>
                <div role="heading" aria-level={2} className="ap-card-title" style={{ marginTop: 4 }}>Fler sidor</div>
              </div>
              <button className="ap-close" onClick={() => setMoreOpen(false)} aria-label="Stäng meny">
                <I p={IC.x} size={16} />
              </button>
            </div>
            <div className="ap-more-sheet-grid">
              {SECONDARY_NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={"ap-more-sheet-item" + (isActive(pathname, n.href) ? " is-active" : "")}
                  aria-current={isActive(pathname, n.href) ? "page" : undefined}
                >
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
      {/* aria-label on each item: the visible label is display:none on the
          narrowest phones, which would otherwise leave an unnamed icon link. */}
      <nav className="ap-mobnav" aria-label="Huvudmeny">
        {PRIMARY_NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-label={n.label}
            aria-current={isActive(pathname, n.href) ? "page" : undefined}
            className={isActive(pathname, n.href) ? "is-active" : ""}
          >
            <I p={n.icon} size={20} /> <span className="ap-mobnav-label">{n.label}</span>
          </Link>
        ))}
        <button
          type="button"
          aria-label="Fler sidor"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={moreOpen || secondaryActive ? "is-active" : ""}
          onClick={() => setMoreOpen(true)}
        >
          <I p={IC.menu} size={20} /> <span className="ap-mobnav-label">Mer</span>
        </button>
      </nav>
    </>
  );
}

function secondaryDescription(href: string) {
  if (href === "/rattning") return "Rätta öppna spel";
  if (href === "/vm2026") return "Turneringsöversikt";
  if (href === "/insights") return "Mönster, form och edge";
  if (href === "/skott") return "Skott och hörnor";
  if (href === "/cs2") return "Lag, spelare och props";
  if (href === "/nba") return "Simulering mot marknaden";
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
  // Every page is a client component, so none of them can export `metadata`;
  // the page header is the one place that knows the page's name.
  useEffect(() => {
    document.title = `${title} · Betting Översikt`;
  }, [title]);

  return (
    <div className="ap-top">
      <div className="ap-top-main">
        {icon && (
          <span className={"ap-chip-icon is-" + accent} aria-hidden="true">
            <I p={icon} size={17} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <h1 className="ap-h1">{title}</h1>
          {sub && <div className="ap-sub">{sub}</div>}
        </div>
      </div>
      {actions && <div className="ap-top-actions">{actions}</div>}
    </div>
  );
}
