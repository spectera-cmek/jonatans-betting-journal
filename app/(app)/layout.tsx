import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { Sidebar, StatusBar, MobileNav } from "@/components/Shell";
import { CommandPalette } from "@/components/CommandPalette";

// Layout for the authenticated app pages — everything except /login and
// /register lives here, so those screens render standalone without the side
// panel / bottom tabs. This server component is the auth gate for every page
// (Node runtime — no Edge middleware): no valid session token, or the user no
// longer exists in the DB → bounce to the login screen.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="ap-shell">
      <Sidebar username={user.username} />
      <div className="ap-content">
        <StatusBar />
        <main id="innehall" tabIndex={-1} className="ap-main">{children}</main>
      </div>
      <MobileNav />
      <CommandPalette />
    </div>
  );
}
