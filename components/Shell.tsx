"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { I, IC } from "./icons";

const NAV = [
  { href: "/", label: "Översikt", icon: IC.grid },
  { href: "/bets", label: "Bets", icon: IC.list },
  { href: "/calendar", label: "Kalender", icon: IC.calendar },
  { href: "/analytics", label: "Analys", icon: IC.chart },
  { href: "/vm2026", label: "VM 2026", icon: IC.trophy },
  { href: "/insights", label: "Insikter", icon: IC.spark },
  { href: "/settings", label: "Inställningar", icon: IC.gear },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar({ username }: { username?: string }) {
  const pathname = usePathname();
  const displayName = username ? username[0].toUpperCase() + username.slice(1) : "—";
  return (
    <aside className="ap-side">
      <div className="ap-logo">
        <div className="mark">J</div>
        <span className="name">Journal</span>
      </div>
      <nav className="ap-nav">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={"ap-navitem" + (isActive(pathname, n.href) ? " is-active" : "")}>
            <I p={n.icon} /> {n.label}
          </Link>
        ))}
      </nav>
      <div className="ap-side-foot">
        <div className="ap-avatar">{username ? username[0].toUpperCase() : "?"}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </div>
          <div style={{ fontSize: 11, color: "var(--dim2)" }}>Personlig journal</div>
        </div>
      </div>
    </aside>
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
}) {
  return (
    <div className="ap-top">
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="ap-h1">{title}</div>
          {sub && <div className="ap-sub">{sub}</div>}
        </div>
      </div>
      <div className="ap-top-actions">{actions}</div>
    </div>
  );
}
