// Prisma-klient för CS2-databasen (prisma/cs2.prisma).
//
// Skild från lib/db.ts och lib/shotsDb.ts med flit: CS2-datan är referensdata
// som läses in i bulk från HLTV och ska aldrig kunna röra speljournalen.
// Klienten genereras till .prisma/cs2-client så den inte skriver över
// huvudschemats klient.

import { PrismaClient } from ".prisma/cs2-client";

const globalForCs2 = globalThis as unknown as { cs2Prisma?: PrismaClient };

export const cs2Prisma =
  globalForCs2.cs2Prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForCs2.cs2Prisma = cs2Prisma;

/** true när en connection string är konfigurerad — UI:t kan då säga varför. */
export function hasCs2Db(): boolean {
  return !!process.env.CS2_DATABASE_URL;
}
