import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy for the admin dashboard (#1935).
 *
 * The /api/admin/* Next.js routes used to forward to the backend with the platform's shared admin
 * secret and no check on the caller, so anyone on the internet could read admin data through them.
 * They now:
 *
 *  1. require a bearer token and ask the backend who it belongs to (401 without one, or when the
 *     backend rejects it);
 *  2. require that user to be an admin (403 otherwise);
 *  3. forward the caller's OWN token, so the backend's role and permission checks apply to them. The
 *     shared admin secret is never attached; and
 *  4. pass on only allow-listed query parameters, each validated.
 */

const ADMIN_ROLES = new Set(["admin", "super_admin"]);

export function backendUrl(): string {
  return process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
}

export function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1] : null;
}

function json(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export type AdminCheck = { ok: true; token: string } | { ok: false; response: NextResponse };

/** Confirms the caller is a signed-in admin. Never touches the admin secret. */
export async function requireAdminCaller(request: NextRequest): Promise<AdminCheck> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, response: json(401, "UNAUTHORIZED", "Authentication required") };
  }

  let me: Response;
  try {
    me = await fetch(`${backendUrl()}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { ok: false, response: json(502, "BAD_GATEWAY", "Could not verify your session") };
  }

  if (me.status === 401) {
    return { ok: false, response: json(401, "UNAUTHORIZED", "Authentication required") };
  }
  if (!me.ok) {
    return { ok: false, response: json(502, "BAD_GATEWAY", "Could not verify your session") };
  }

  const body = (await me.json().catch(() => null)) as { user?: { role?: string } } | null;
  const role = body?.user?.role;
  if (!role || !ADMIN_ROLES.has(role)) {
    return { ok: false, response: json(403, "FORBIDDEN", "Admin access required") };
  }
  return { ok: true, token };
}

/** One allowed query parameter and how to check its value. */
export type QueryRule = (value: string) => boolean;

export const oneOf =
  (...allowed: string[]): QueryRule =>
  (value) =>
    allowed.includes(value);

export const intBetween =
  (min: number, max: number): QueryRule =>
  (value) => /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;

export const shortToken: QueryRule = (value) => /^[A-Za-z0-9_\-=.:]{1,200}$/.test(value);

/**
 * Keeps only the parameters in `rules`. Unknown parameters are dropped; a known one with an invalid
 * value is an error (returned as a 400 response) rather than being forwarded.
 */
export function allowListQuery(
  request: NextRequest,
  rules: Record<string, QueryRule>,
): { ok: true; search: string } | { ok: false; response: NextResponse } {
  const out = new URLSearchParams();
  for (const [name, value] of request.nextUrl.searchParams.entries()) {
    const rule = rules[name];
    if (!rule) continue;
    if (!rule(value)) {
      return { ok: false, response: json(400, "VALIDATION_ERROR", `Invalid value for "${name}"`) };
    }
    out.set(name, value);
  }
  const search = out.toString();
  return { ok: true, search: search ? `?${search}` : "" };
}

/** GET `path` on the backend with the caller's own token, and relay the answer. */
export async function proxyAdminGet(
  request: NextRequest,
  path: string,
  query: Record<string, QueryRule> = {},
): Promise<NextResponse> {
  const caller = await requireAdminCaller(request);
  if (!caller.ok) return caller.response;

  const params = allowListQuery(request, query);
  if (!params.ok) return params.response;

  let response: Response;
  try {
    response = await fetch(`${backendUrl()}${path}${params.search}`, {
      headers: { authorization: `Bearer ${caller.token}` },
      cache: "no-store",
    });
  } catch {
    return json(502, "BAD_GATEWAY", "Backend unavailable");
  }

  return new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}
