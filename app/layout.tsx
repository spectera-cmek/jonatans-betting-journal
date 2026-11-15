import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Sans_Condensed, IBM_Plex_Mono } from "next/font/google";
// Order matters: Tailwind's reset first, then the app's own layers.
import "./globals.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/tables.css";
import "./styles/forms.css";
import "./styles/charts.css";
import "./styles/pages/dashboard.css";
import "./styles/pages/bets.css";
import "./styles/pages/calendar.css";
import "./styles/pages/queue.css";
import "./styles/pages/skott.css";
import "./styles/pages/vm.css";
import "./styles/pages/cs2.css";
import "./styles/pages/nba.css";
import "./styles/pages/settings.css";
import "./styles/pages/auth.css";
import "./styles/a11y.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_COLOR } from "@/lib/theme";

// One superfamily, self-hosted by Next and preloaded: Sans for prose, Sans
// Condensed (set in caps) for headings and labels, Mono for every number.
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});
const disp = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-disp",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Betting Översikt",
  description: "Personlig betting-översikt — bets, ROI och form, med auto-rättning från kontoutdrag.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Översikt",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLOR.dark,
};

// Applies the stored preferences to <html> before first paint, so the app can
// render its real content immediately instead of holding everything back until
// React has hydrated: the colour mode, and whether the side panel is folded to
// its icon rail. Storage keys are the ones ThemeProvider and Shell use.
const THEME_INIT = `(function(){try{
var d=document.documentElement,s=window.localStorage;
d.setAttribute("data-mode",s.getItem("bj.mode")==="light"?"light":"dark");
if(s.getItem("bj.nav")==="rail")d.setAttribute("data-nav","rail");
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="sv"
      className={`${sans.variable} ${disp.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
