import { PrismaClient } from "@prisma/client";

// Reuse the Prisma client across hot reloads in dev to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Fetch a user's settings row, creating defaults if missing. */
export async function getSettings(userId: string) {
  return prisma.setting.upsert({ where: { userId }, update: {}, create: { userId } });
}
