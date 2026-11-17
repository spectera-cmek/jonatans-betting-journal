// Skapa en återställningslänk åt någon som glömt sitt lösenord.
//
//   npm run user:reset-link -- <användarnamn>
//   npm run user:reset-link -- <användarnamn> --hours 2 --base http://localhost:3000
//
// Länken gäller i 24 timmar (eller --hours) och bara en gång: den slutar gälla
// när lösenordet byts. Skicka den själv till personen — appen har ingen e-post.
//
// Signeras med AUTH_SECRET, så den måste vara samma som i produktion för att en
// länk till produktionsadressen ska fungera. .env.vercel.local läses först
// (där ligger produktionens), sedan .env.local och .env.
import { config } from "dotenv";
config({ path: ".env.vercel.local" });
config({ path: ".env.local" });
config({ path: ".env" });

import { PrismaClient } from "@prisma/client";
import { createResetToken, RESET_TTL_SEC } from "../lib/passwordReset";

const DEFAULT_BASE = "https://project-yp6b3.vercel.app";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  if (!username) throw new Error("Ange användarnamnet: npm run user:reset-link -- <användarnamn>");
  const hours = Number(arg("--hours") ?? RESET_TTL_SEC / 3600);
  if (!(hours > 0 && hours <= 72)) throw new Error("--hours måste vara mellan 0 och 72");
  const base = (arg("--base") ?? process.env.APP_URL ?? DEFAULT_BASE).replace(/\/$/, "");

  const prisma = new PrismaClient();
  const user = await prisma.user.findUnique({
    where: { username: username.toLowerCase() },
    select: { id: true, username: true, passwordHash: true },
  });
  await prisma.$disconnect();
  if (!user) throw new Error(`Hittar ingen användare som heter ${username}`);

  const token = createResetToken(user.id, user.passwordHash, Math.round(hours * 3600));
  const until = new Date(Date.now() + hours * 3600e3).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
  console.log(`Återställningslänk för ${user.username} (gäller till ${until}, en gång):`);
  console.log(`${base}/aterstall?token=${encodeURIComponent(token)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
