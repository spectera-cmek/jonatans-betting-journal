"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { I, IC } from "./icons";
import { GlobalActions } from "./GlobalActions";

const PRIMARY_NAV = [
  { href: "/", label: "Översikt", icon: IC.dashboard },
  { href: "/bets", label: "Bets", icon: IC.ticket },
  { href: "/calendar", label: "Kalender", icon: IC.calendar },
  { href: "/analytics", label: "Analys", icon: IC.chart },
];

const SECONDARY_NAV = [
  { href: "/vm2026", label: "VM 2026", icon: IC.trophy },
  { href: "/insights", label: "Insikter", icon: IC.spark },
  { href: "/fairodds", label: "Fair odds", icon: IC.percent },
  { href: "/verktyg", label: "Verktyg", icon: IC.wrench },
  { href: "/settings", label: "Inställningar", icon: IC.gear },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** Sticky global header: brand + horizontal nav pills + global actions + avatar. */
export function TopNav({ username }: { username?: string }) {
  const pathname = usePathname();
  return (
    <header className="ap-topnav">
      <div className="ap-topnav-inner">
        <Link href="/" className="ap-brand" aria-label="Översikt">
          <span className="name">Betting Journal</span>
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
                <span className="ap-label">Betting Journal</span>
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
  if (href === "/fairodds") return "Räkna ut rättvist odds";
  if (href === "/verktyg") return "Hedge, cashout och Kelly";
  return "Konto och konfiguration";
}

export function Topbar({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Accepted for backwards-compat with pages that still pass one; the redesign
   *  renders a clean bordered header with no icon chip. */
  icon?: React.ReactNode;
}) {
  return (
    <div className="ap-top">
      <div style={{ minWidth: 0 }}>
        <div className="ap-h1">{title}</div>
        {sub && <div className="ap-sub">{sub}</div>}
      </div>
      {actions && <div className="ap-top-actions">{actions}</div>}
    </div>
  );
}
