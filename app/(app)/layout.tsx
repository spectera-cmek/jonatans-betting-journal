import { Sidebar, MobileNav } from "@/components/Shell";
import { TweaksPanel } from "@/components/TweaksPanel";

// Layout for the authenticated app pages — everything except /login lives here,
// so the login screen renders standalone without the sidebar / bottom nav.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="ap-shell">
        <Sidebar />
        <main className="ap-main">{children}</main>
      </div>
      <MobileNav />
      <TweaksPanel />
    </>
  );
}
