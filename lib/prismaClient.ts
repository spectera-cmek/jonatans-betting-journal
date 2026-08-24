// One place that decides *how* the Prisma client reaches Postgres.
//
// By default it is the ordinary TCP connection on port 5432 — what Vercel,
// local `next dev` and the CLI scripts have always used, unchanged.
//
// Cloud sessions (Claude Code on the web) are the exception: their egress
// gateway only forwards HTTP/HTTPS, so a Postgres socket on 5432 never leaves
// the container and every script dies with a Prisma initialization error. Neon
// also speaks its own protocol over 443, so setting PRISMA_NEON_SERVERLESS=1
// swaps the socket for @neondatabase/serverless and the same code works from a
// cloud session. The environment must allow `*.neon.tech` (Network access ->
// Custom) for that traffic to get out.
//
// The flag only makes sense for a Neon-hosted database; any other Postgres host
// still needs a real TCP route.

import { PrismaClient, type Prisma } from "@prisma/client";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";

// PRISMA_NEON_HTTP is accepted as an alias: the transport is a WebSocket over
// HTTPS, so both names describe the same "go over 443" switch.
const FLAGS = ["PRISMA_NEON_SERVERLESS", "PRISMA_NEON_HTTP"] as const;

const MISSING_URL =
  "DATABASE_URL is not set. Locally: copy .env.example to .env and fill it in. " +
  "In a cloud session: set it in the environment's variables at claude.ai/code " +
  "(see DEPLOY.md — cloud sessions also need PRISMA_NEON_SERVERLESS=1 and " +
  "network access to *.neon.tech).";

/** True when the Neon-over-HTTPS transport is switched on. */
export function usesNeonServerless(): boolean {
  return FLAGS.some((flag) => {
    const v = process.env[flag]?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  });
}

/**
 * Fail early with an actionable message instead of a Prisma stack trace 40
 * lines deep. Scripts call this before they touch the database.
 */
export function assertDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) throw new Error(MISSING_URL);
}

/**
 * Turn a connection failure into something readable. The serverless transport
 * throws a raw WebSocket ErrorEvent, which dumps a page of socket internals and
 * says nothing about the two things that actually cause it: a non-Neon host, or
 * an environment that doesn't allow *.neon.tech.
 */
export function describeDbError(e: unknown): string | null {
  if (!usesNeonServerless()) return null;
  if (typeof e !== "object" || e === null) return null;
  // A WebSocket ErrorEvent, and nothing else: anything that is a real Error
  // (Prisma's own failures included) already says something useful.
  const isSocketEvent = "target" in e || (e as { type?: unknown }).type === "error";
  if (!isSocketEvent) return null;
  const host = process.env.DATABASE_URL?.match(/@([^/:?]+)/)?.[1] ?? "the database host";
  return (
    `Could not reach ${host} over the Neon serverless transport (PRISMA_NEON_SERVERLESS=1). ` +
    "Check that the host is a Neon endpoint and that the session's network access allows *.neon.tech."
  );
}

/** Neon's serverless driver, wrapped as a Prisma driver adapter. */
function neonAdapter(connectionString: string): PrismaNeon {
  // Node has no global WebSocket before 22; the driver needs one either way.
  neonConfig.webSocketConstructor ??= ws;
  return new PrismaNeon(new Pool({ connectionString }));
}

/**
 * Build a Prisma client for the bet journal. Pass the same options you would
 * pass to `new PrismaClient()`.
 */
export function createPrismaClient(options?: Prisma.PrismaClientOptions): PrismaClient {
  if (!usesNeonServerless()) return new PrismaClient(options);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(MISSING_URL);
  return new PrismaClient({ ...options, adapter: neonAdapter(url) });
}
