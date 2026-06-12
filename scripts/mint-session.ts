// Dev helper: mint a short-lived session cookie for a user so the preview
// browser can be logged in without a password. Prints only the cookie value.
//   npx tsx scripts/mint-session.ts <username> [maxAgeSec]
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { createHmac } from "crypto";
import { PrismaClient } from "@prisma/client";

async function main() {
  const username = process.argv[2] ?? "jonatan";
  const maxAge = Number(process.argv[3] ?? 7200);
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");

  const prisma = new PrismaClient();
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  await prisma.$disconnect();
  if (!user) throw new Error(`user ${username} not found`);

  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const payload = `${Buffer.from(user.id, "utf8").toString("base64url")}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  console.log(`${payload}.${sig}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
