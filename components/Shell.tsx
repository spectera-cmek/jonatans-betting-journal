"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { I, IC } from "./icons";

const NAV = [
  { href: "/", label: "Översikt", icon: IC.grid },
  { href: "/bets", label: "Bets", icon: IC.list },
  { href: "/calendar", label: "Kalender", icon: IC.calendar },
  { href: "/analytics", label: "Analys", icon: IC.chart },
  { href: "/insights", label: "Insikter", icon: IC.spark },
  { href: "/settings", label: "Inställningar", icon: IC.gear },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Sidebar() {
  const pathname = usePathname();
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
        <div className="ap-avatar">J</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Jonatan
          </div>
          <div style={{ fontSize: 11, color: "var(--dim2)" }}>Lokal journal · SQLite</div>
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
          <I p={n.icon} size={20} /> {n.label}
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
