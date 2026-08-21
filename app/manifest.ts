import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest — makes the app installable on a phone
// home screen ("Lägg till på hemskärmen") so it launches like a native app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Betting Översikt",
    short_name: "Översikt",
    description: "Personlig betting-översikt — bets, ROI och form.",
    lang: "sv",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0b0f",
    theme_color: "#0a0b0f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
