"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useDialog } from "@/lib/useDialog";
import { I, IC, BrandMark } from "./icons";
import { GlobalActions } from "./GlobalActions";
import { useTheme } from "./ThemeProvider";
import { useMetrics } from "@/lib/useData";
import { krShort, pctFmt } from "@/lib/format";
import { NAV_GROUPS, SETTINGS_NAV, MOBILE_TABS, isActive, type NavItem } from "@/lib/nav";
import { CMD, emit } from "@/lib/commands";

/** Open-bet count for the "Rättning" badge. Shares the cached /api/metrics
 *  payload with the tape and the dashboard, so it costs no request of its own. */
function useOpenCount(): number {
  const { data } = useMetrics();
  return data?.openRisk?.bets ?? 0;
}

/** Whether the side panel is folded to its icon rail. The choice is stored and
 *  mirrored on <html data-nav>, which the pre-paint script also sets, so the
 *  panel never jumps width on load. */
function useRail(): [boolean, () => void] {
  const [rail, setRail] = useState(false);
  useEffect(() => {
    setRail(document.documentElement.getAttribute("data-nav") === "rail");
  }, []);
  const toggle = useCallback(() => {
    setRail((prev) => {
      const next = !prev;
      if (next) document.documentElement.setAttribute("data-nav", "rail");
      else document.documentElement.removeAttribute("data-nav");
      try { localStorage.setItem("bj.nav", next ? "rail" : "full"); } catch {}
      return next;
    });
  }, []);
  return [rail, toggle];
}

function NavLink({ item, pathname, badge }: { item: NavItem; pathname: string; badge?: number }) {
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      className={"ap-navitem" + (active ? " is-active" : "")}
      aria-current={active ? "page" : undefined}
      // In rail mode the label is hidden, so the name has to come from here.
      title={item.label}
    >
      <I p={item.icon} size={16} />
      <span className="ap-navitem-label">{item.label}</span>
      {badge ? (
        <span className="ap-navbadge" aria-label={`${badge} öppna spel`}>
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Fixed left panel: every page, grouped. Folds to an icon rail. */
export function Sidebar({ username }: { username?: string }) {
  const pathname = usePathname();
  const { mode, setMode } = useTheme();
  const openCount = useOpenCount();
  const [rail, toggleRail] = useRail();

  return (
    <aside className="ap-side">
      <Link href="/" className="ap-brand" aria-label="Betting Översikt – till startsidan">
        <span className="mark" aria-hidden="true">
          <BrandMark />
        </span>
        <span className="name">
          Betting <em>Översikt</em>
        </span>
      </Link>

      <nav className="ap-sidenav" aria-label="Huvudmeny">
        {NAV_GROUPS.map((g) => (
          <div key={g.key} className="ap-navgroup" role="group" aria-label={g.label}>
            <span className="ap-navgroup-label" aria-hidden="true">{g.label}</span>
            {g.items.map((n) => (
              <NavLink key={n.href} item={n} pathname={pathname} badge={n.href === "/rattning" ? openCount : undefined} />
            ))}
          </div>
        ))}
      </nav>

      <div className="ap-side-foot">
        <NavLink item={SETTINGS_NAV} pathname={pathname} />
        <button
          type="button"
          className="ap-navitem"
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
          title={mode === "dark" ? "Byt till ljust läge" : "Byt till mörkt läge"}
        >
          <I p={mode === "dark" ? IC.sun : IC.moon} size={16} />
          <span className="ap-navitem-label">{mode === "dark" ? "Ljust läge" : "Mörkt läge"}</span>
        </button>
        <button
          type="button"
          className="ap-navitem ap-nav-collapse"
          onClick={toggleRail}
          aria-pressed={rail}
          title={rail ? "Visa hela menyn" : "Fäll ihop menyn"}
        >
          <I p={rail ? IC.panelOpen : IC.panelClose} size={16} />
          <span className="ap-navitem-label">Fäll ihop</span>
        </button>
        {username && (
          <div className="ap-side-user" title={`Inloggad som ${username}`}>
            <i aria-hidden="true" />
            <span>{username}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * The tape: realised result, ROI, stake in open bets and how many are open.
 * Reads the same metrics payload the dashboard uses.
 */
function Ticker() {
  const { data } = useMetrics();
  if (!data) return null;
  const unit = data.settings.unitValue ?? 100;
  const profitKr = (data.metrics?.profitUnits ?? 0) * unit;
  const roi = data.metrics?.roiPct ?? null;
  const risk = data.openRisk;
  const openKr = risk ? risk.stakeUnits * unit : 0;
  // From openRisk, not openBets.length: /api/metrics caps that list at the 25
  // soonest bets.
  const openCount = risk?.bets ?? 0;

  return (
    <div className="ap-ticker" role="group" aria-label="Bankrulle">
      <div>
        <span>Netto</span>
        <strong className={profitKr >= 0 ? "pos" : "neg"}>{krShort(profitKr, true)}</strong>
      </div>
      <div>
        <span>ROI</span>
        <strong className={roi == null ? undefined : roi >= 0 ? "pos" : "neg"}>{pctFmt(roi, true)}</strong>
      </div>
      <div>
        <span>Exponerat</span>
        <strong>{krShort(openKr, false)}</strong>
      </div>
      <div>
        <span>Öppna</span>
        <strong className={openCount > 0 ? "is-attn" : undefined}>{openCount}</strong>
      </div>
    </div>
  );
}

/** Sticky bar above the page: quick search, the tape, and the global actions. */
export function StatusBar() {
  // ⌘ on Apple hardware, Ctrl elsewhere. Decided after mount to keep the server
  // and first client render identical.
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);

  return (
    <header className="ap-status">
      <a href="#innehall" className="ap-skip">Hoppa till innehållet</a>
      <Link href="/" className="ap-status-brand" aria-label="Betting Översikt – till startsidan">
        <span className="mark" aria-hidden="true">
          <BrandMark />
        </span>
      </Link>
      <button type="button" className="ap-cmdk-trigger" aria-haspopup="dialog" onClick={() => emit(CMD.palette)}>
        <I p={IC.search} size={15} />
        <span>Sök eller hoppa till…</span>
        <kbd className="ap-kbd">{mod} K</kbd>
      </button>
      <Ticker />
      <div className="ap-status-actions">
        <GlobalActions />
      </div>
    </header>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const { mode, setMode } = useTheme();
  const openCount = useOpenCount();
  const [moreOpen, setMoreOpen] = useState(false);
  const inTabs = MOBILE_TABS.some((n) => isActive(pathname, n.href));

  useEffect(() => setMoreOpen(false), [pathname]);
  const sheetRef = useDialog<HTMLDivElement>(moreOpen, () => setMoreOpen(false));
  const tabHrefs = new Set(MOBILE_TABS.map((n) => n.href));

  return (
    <>
      {moreOpen && (
        <div className="ap-more-sheet-overlay" onClick={() => setMoreOpen(false)}>
          <div ref={sheetRef} tabIndex={-1} className="ap-more-sheet" role="dialog" aria-modal="true" aria-label="Fler sidor" onClick={(e) => e.stopPropagation()}>
            <div className="ap-more-sheet-head">
              <div role="heading" aria-level={2} className="ap-card-title">Fler sidor</div>
              <button className="ap-close" onClick={() => setMoreOpen(false)} aria-label="Stäng meny">
                <I p={IC.x} size={16} />
              </button>
            </div>
            {NAV_GROUPS.map((g) => {
              const items = g.items.filter((n) => !tabHrefs.has(n.href));
              if (items.length === 0) return null;
              return (
                <div key={g.key} className="ap-more-sheet-group" role="group" aria-label={g.label}>
                  <span className="ap-navgroup-label" aria-hidden="true">{g.label}</span>
                  {items.map((n) => (
                    <SheetLink key={n.href} item={n} pathname={pathname} badge={n.href === "/rattning" ? openCount : undefined} />
                  ))}
                </div>
              );
            })}
            <div className="ap-more-sheet-group" role="group" aria-label="Konto">
              <span className="ap-navgroup-label" aria-hidden="true">Konto</span>
              <SheetLink item={SETTINGS_NAV} pathname={pathname} />
              <button type="button" className="ap-more-sheet-item" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>
                <span className="ap-more-sheet-icon"><I p={mode === "dark" ? IC.sun : IC.moon} size={19} /></span>
                <span>
                  <strong>{mode === "dark" ? "Ljust läge" : "Mörkt läge"}</strong>
                  <small>Byt utseende</small>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* aria-label on each item: the visible label is display:none on the
          narrowest phones, which would otherwise leave an unnamed icon link. */}
      <nav className="ap-mobnav" aria-label="Huvudmeny">
        {MOBILE_TABS.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-label={n.label}
            aria-current={isActive(pathname, n.href) ? "page" : undefined}
            className={isActive(pathname, n.href) ? "is-active" : ""}
          >
            <I p={n.icon} size={19} /> <span className="ap-mobnav-label">{n.label}</span>
          </Link>
        ))}
        <button
          type="button"
          aria-label="Fler sidor"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={moreOpen || !inTabs ? "is-active" : ""}
          onClick={() => setMoreOpen(true)}
        >
          <I p={IC.menu} size={19} /> <span className="ap-mobnav-label">Mer</span>
        </button>
      </nav>
    </>
  );
}

function SheetLink({ item, pathname, badge }: { item: NavItem; pathname: string; badge?: number }) {
  const active = isActive(pathname, item.href);
  return (
    <Link href={item.href} className={"ap-more-sheet-item" + (active ? " is-active" : "")} aria-current={active ? "page" : undefined}>
      <span className="ap-more-sheet-icon"><I p={item.icon} size={19} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong>{item.label}</strong>
        <small>{item.desc}</small>
      </span>
      {badge ? <span className="ap-navbadge">{badge}</span> : null}
    </Link>
  );
}

/** Page head: the page's name in caps, a one-line note, and its own actions. */
export function Topbar({
  title,
  sub,
  actions,
  docTitle,
}: {
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  /** Browser-tab title, verbatim. Defaults to "<title> · Betting Översikt". */
  docTitle?: string;
}) {
  // Every page is a client component, so none of them can export `metadata`;
  // the page header is the one place that knows the page's name.
  useEffect(() => {
    document.title = docTitle ?? `${title} · Betting Översikt`;
  }, [title, docTitle]);

  return (
    <div className="ap-top">
      <div className="ap-top-main">
        <h1 className="ap-h1">{title}</h1>
        {sub && <div className="ap-sub">{sub}</div>}
      </div>
      {actions && <div className="ap-top-actions">{actions}</div>}
    </div>
  );
}
