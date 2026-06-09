import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { Sidebar, MobileNav } from "@/components/Shell";
import { TweaksPanel } from "@/components/TweaksPanel";

// Layout for the authenticated app pages — everything except /login lives here,
// so the login screen renders standalone without the sidebar / bottom nav.
// This server component is the auth gate for every page (Node runtime — no Edge
// middleware): no valid session cookie → bounce to the login screen.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isAuthed()) redirect("/login");

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
