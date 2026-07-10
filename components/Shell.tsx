"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { I, IC } from "./icons";
import { GlobalActions } from "./GlobalActions";

const NAV = [
  { href: "/", label: "Översikt", icon: IC.grid },
  { href: "/bets", label: "Bets", icon: IC.list },
  { href: "/calendar", label: "Kalender", icon: IC.calendar },
  { href: "/analytics", label: "Analys", icon: IC.chart },
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
  const initial = username ? username[0].toUpperCase() : "?";
  return (
    <header className="ap-topnav">
      <div className="ap-topnav-inner">
        <Link href="/" className="ap-brand" aria-label="Översikt">
          <div className="mark">J</div>
          <span className="name">Journal</span>
        </Link>
        <nav className="ap-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={"ap-navitem" + (isActive(pathname, n.href) ? " is-active" : "")}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ap-topnav-actions">
          <GlobalActions />
          <Link href="/settings" className="ap-avatar" title={username ? username[0].toUpperCase() + username.slice(1) : "Konto"}>
            {initial}
          </Link>
        </div>
      </div>
    </header>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <div className="ap-mobnav">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className={isActive(pathname, n.href) ? "is-active" : ""}>
          <I p={n.icon} size={20} /> <span className="ap-mobnav-label">{n.label}</span>
        </Link>
      ))}
    </div>
  );
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
