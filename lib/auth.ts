// Single-user session auth. The session cookie's value is the AUTH_SECRET itself
// (a long random string) — possessing it == being authenticated. No crypto, so it
// behaves identically in the Edge middleware (string compare) and this Node route.
// Rotate AUTH_SECRET to invalidate all existing sessions.

export const SESSION_COOKIE = "bj_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
