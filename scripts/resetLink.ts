// Skapa en återställningslänk åt någon som glömt sitt lösenord.
//
//   npm run user:reset-link -- <användarnamn>
//   npm run user:reset-link -- <användarnamn> --hours 2 --base http://localhost:3000
//
// Länken gäller i 24 timmar (eller --hours, högst 72) och bara en gång. En ny
// länk ersätter den förra. Skicka den själv till personen — appen har ingen
// e-post. Koden sparas bara som hash i databasen (DATABASE_URL ur .env).
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { PrismaClient } from "@prisma/client";
import { newResetToken, RESET_TTL_SEC } from "../lib/passwordReset";

const DEFAULT_BASE = "https://project-yp6b3.vercel.app";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  // Första argumentet som varken är en flagga eller en flaggas värde.
  const args = process.argv.slice(2);
  const username = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!username) throw new Error("Ange användarnamnet: npm run user:reset-link -- <användarnamn>");
  const hours = Number(arg("--hours") ?? RESET_TTL_SEC / 3600);
  if (!(hours > 0 && hours <= 72)) throw new Error("--hours måste vara mellan 0 och 72");
  const base = (arg("--base") ?? process.env.APP_URL ?? DEFAULT_BASE).replace(/\/$/, "");

  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { username: username.toLowerCase() }, select: { id: true, username: true } });
    if (!user) throw new Error(`Hittar ingen användare som heter ${username}`);
    const { token, hash, expiresAt } = newResetToken(Math.round(hours * 3600));
    await prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: hash, resetTokenExpiresAt: expiresAt } });
    const until = expiresAt.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
    console.log(`Återställningslänk för ${user.username} (gäller till ${until}, en gång):`);
    console.log(`${base}/aterstall?token=${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
