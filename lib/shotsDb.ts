// Prisma-klient för skottmodellens egna databas (prisma/shots.prisma).
//
// Skild från lib/db.ts med flit: skottmodellen är referensdata som laddas om i
// bulk, och ska aldrig kunna röra speljournalen. Klienten genereras till
// .prisma/shots-client så den inte skriver över huvudschemats klient.

import { PrismaClient } from ".prisma/shots-client";

const globalForShots = globalThis as unknown as { shotsPrisma?: PrismaClient };

export const shotsPrisma =
  globalForShots.shotsPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForShots.shotsPrisma = shotsPrisma;

/** true när en connection string är konfigurerad — UI:t kan då säga varför. */
export function hasShotsDb(): boolean {
  return !!process.env.SHOTS_DATABASE_URL;
}
