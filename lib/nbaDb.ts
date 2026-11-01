// Prisma-klient för NBA-databasen (prisma/nba.prisma).
//
// Skild från lib/db.ts, lib/shotsDb.ts och lib/cs2Db.ts med flit: NBA-datan
// är referensdata som läses in i bulk från ESPN och OddsPapi och ska aldrig
// kunna röra speljournalen. Klienten genereras till .prisma/nba-client.

import { PrismaClient } from ".prisma/nba-client";

const globalForNba = globalThis as unknown as { nbaPrisma?: PrismaClient };

export const nbaPrisma =
  globalForNba.nbaPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForNba.nbaPrisma = nbaPrisma;

export type NbaPrisma = PrismaClient;

/** true när en connection string är konfigurerad — UI:t kan då säga varför. */
export function hasNbaDb(): boolean {
  return !!process.env.NBA_DATABASE_URL;
}
