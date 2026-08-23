import { PrismaClient } from "@prisma/client";

// Reuse the Prisma client across hot reloads in dev to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Fetch a user's settings row, creating defaults if missing.
 *  Reads first: this runs on every GET /api/settings and every GET /api/metrics,
 *  and an unconditional upsert is a write transaction (~150 ms vs ~27 ms for the
 *  read) even though the row virtually always already exists. */
export async function getSettings(userId: string) {
  const existing = await prisma.setting.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.setting.upsert({ where: { userId }, update: {}, create: { userId } });
}
