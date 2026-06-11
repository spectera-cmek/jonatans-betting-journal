// Dev helper: print a valid session cookie for a user (for local preview testing).
// Usage: npx tsx scripts/dev-session.ts <username>
import { prisma } from "../lib/db";
import { createSessionToken, SESSION_COOKIE } from "../lib/auth";

async function main() {
  const username = process.argv[2] ?? "jonatan";
  const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw new Error(`user ${username} not found`);
  console.log(`${SESSION_COOKIE}=${createSessionToken(user.id, 3600)}`);
}

main().finally(() => prisma.$disconnect());
