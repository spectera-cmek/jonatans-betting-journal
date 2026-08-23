import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ACCENTS } from "@/lib/theme";

// Self-hosted by Next and preloaded. These were previously pulled in by an
// @import at the top of globals.css, which forced a serial render-blocking
// chain: HTML -> globals.css -> fonts.googleapis.com -> fonts.gstatic.com.
// Same three families, same weights.
const sans = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
const disp = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-disp",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
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
  themeColor: "#0a0b0f",
};

// Applies the stored theme to <html> before first paint, so the app can render
// its real content immediately instead of holding everything back until React
// has hydrated. Storage keys and the accent table are the same ones the
// ThemeProvider uses — ACCENTS is serialised from lib/theme so there is still
// only one source of truth. An unknown stored accent is ignored, matching the
// provider, and the CSS defaults on :root then stand.
const THEME_INIT = `(function(){try{
var d=document.documentElement,s=window.localStorage;
d.setAttribute("data-mode",s.getItem("bj.mode")==="light"?"light":"dark");
var a=s.getItem("bj.accent"),t=${JSON.stringify(
  ACCENTS.map((a) => ({ hex: a.hex, soft: a.soft, text: a.text }))
)};
for(var i=0;i<t.length;i++){if(t[i].hex===a){d.style.setProperty("--acc",t[i].hex);d.style.setProperty("--acc-soft",t[i].soft);d.style.setProperty("--acc-text",t[i].text);break;}}
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
