// Tiny client-side fetch helpers with JSON + error handling.

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  // Session expired / not signed in → bounce to the login page.
  if (res.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => jsonFetch<T>(url),
  post: <T>(url: string, body?: unknown) =>
    jsonFetch<T>(url, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(url: string, body: unknown) =>
    jsonFetch<T>(url, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(url: string, body: unknown) =>
    jsonFetch<T>(url, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(url: string) => jsonFetch<T>(url, { method: "DELETE" }),
};
