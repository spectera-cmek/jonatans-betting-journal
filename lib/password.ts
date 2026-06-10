// Password hashing (bcryptjs — pure JS, no native bindings, works on Vercel)
// and credential validation. Cost 10 keeps login/register ~50–150 ms on a
// serverless cold start; hashing never runs on regular authenticated requests.

import bcrypt from "bcryptjs";

export const BCRYPT_COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// Burn a bcrypt compare when the username doesn't exist, so login timing
// doesn't reveal which usernames are taken.
let dummyHash: string | null = null;
export async function verifyDummy(plain: string): Promise<void> {
  if (!dummyHash) dummyHash = await bcrypt.hash("not-a-real-password", BCRYPT_COST);
  await bcrypt.compare(plain, dummyHash);
}

const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

// Validators return a Swedish error message, or null if valid.
// Usernames are stored lowercase; lowercase before calling.
export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "Användarnamnet måste vara 3–20 tecken: a–z, 0–9, bindestreck eller understreck.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < 8) return "Lösenordet måste vara minst 8 tecken.";
  return null;
}
