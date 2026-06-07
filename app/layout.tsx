import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Sidebar, MobileNav } from "@/components/Shell";
import { TweaksPanel } from "@/components/TweaksPanel";

export const metadata: Metadata = {
  title: "Jonatans Betting Journal",
  description: "Jonatans personliga betting-journal — bets, ROI och form, med auto-rättning från kontoutdrag.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>
        <ThemeProvider>
          <div className="ap-shell">
            <Sidebar />
            <main className="ap-main">{children}</main>
          </div>
          <MobileNav />
          <TweaksPanel />
        </ThemeProvider>
      </body>
    </html>
  );
}
