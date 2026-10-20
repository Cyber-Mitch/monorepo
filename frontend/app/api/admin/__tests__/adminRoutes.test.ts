import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as getAlerts } from "../alerts/route";
import { GET as getSnapshot } from "../health-snapshot/route";
import { GET as getJobsHealth } from "../jobs/health/route";

const SECRET = "super-secret-admin-value";

type Handler = (request: NextRequest) => Promise<Response>;
const routes: Array<[string, Handler, string]> = [
  ["alerts", getAlerts as Handler, "/api/admin/alerts"],
  ["health-snapshot", getSnapshot as Handler, "/api/admin/health-snapshot"],
  ["jobs/health", getJobsHealth as Handler, "/api/admin/jobs/health"],
];

const fetchMock = vi.fn();

function req(path: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Backend double: /auth/me answers per token, anything else is echoed back. */
function backend(users: Record<string, { role: string } | "invalid">) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith("/api/v1/auth/me")) {
      const token = headers.get("authorization")?.replace("Bearer ", "") ?? "";
      const user = users[token];
      if (!user || user === "invalid") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ user }), { status: 200 });
    }
    return new Response(JSON.stringify({ proxied: String(url), auth: headers.get("authorization"), secret: headers.get("x-admin-secret") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const backendCalls = () => fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/api/v1/auth/me"));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("BACKEND_URL", "http://backend.test");
  vi.stubEnv("ADMIN_SECRET", SECRET);
  vi.stubEnv("MANUAL_ADMIN_SECRET", SECRET);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(routes)("GET /api/admin/%s (#1935)", (_name, handler, path) => {
  it("rejects an anonymous caller with 401 and never calls the backend with the secret", async () => {
    backend({});

    const res = await handler(req(path));

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a token the backend does not accept with 401, and sends nothing else", async () => {
    backend({ stale: "invalid" });

    const res = await handler(req(path, "stale"));

    expect(res.status).toBe(401);
    expect(backendCalls()).toHaveLength(0);
  });

  it("rejects a signed-in non-admin with 403", async () => {
    backend({ tenantToken: { role: "tenant" } });

    const res = await handler(req(path, "tenantToken"));

    expect(res.status).toBe(403);
    expect(backendCalls()).toHaveLength(0);
  });

  it("proxies for an admin with that admin's own token, and never sends the admin secret", async () => {
    backend({ adminToken: { role: "admin" } });

    const res = await handler(req(path, "adminToken"));

    expect(res.status).toBe(200);
    const [[url, init]] = backendCalls();
    expect(String(url).startsWith(`http://backend.test${path}`)).toBe(true);
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer adminToken");
    expect(headers.get("x-admin-secret")).toBeNull();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(SECRET);
  });

  it("also lets a super_admin through", async () => {
    backend({ root: { role: "super_admin" } });

    expect((await handler(req(path, "root"))).status).toBe(200);
  });

  it("answers 502 when the session cannot be verified, rather than proxying", async () => {
    fetchMock.mockRejectedValue(new Error("down"));

    const res = await handler(req(path, "adminToken"));

    expect(res.status).toBe(502);
  });

  it("relays the backend's own refusal (an admin without the permission)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/api/v1/auth/me")
        ? new Response(JSON.stringify({ user: { role: "admin" } }), { status: 200 })
        : new Response('{"error":{"code":"FORBIDDEN"}}', { status: 403 }),
    );

    expect((await handler(req(path, "adminToken"))).status).toBe(403);
  });
});

describe("GET /api/admin/alerts query parameters", () => {
  const forwarded = () => String(backendCalls()[0][0]);

  it("forwards only allow-listed parameters", async () => {
    backend({ adminToken: { role: "admin" } });

    await getAlerts(req("/api/admin/alerts?severity=high&status=open&limit=20&cursor=abc123&evil=1&x-admin-secret=1", "adminToken"));

    const search = new URL(forwarded()).searchParams;
    expect(Object.fromEntries(search)).toEqual({ severity: "high", status: "open", limit: "20", cursor: "abc123" });
  });

  it.each([
    ["severity=bogus"],
    ["status=deleted"],
    ["limit=0"],
    ["limit=101"],
    ["limit=abc"],
    ["cursor=../../etc/passwd"],
  ])("rejects an invalid value (%s) with 400 instead of forwarding it", async (query) => {
    backend({ adminToken: { role: "admin" } });

    const res = await getAlerts(req(`/api/admin/alerts?${query}`, "adminToken"));

    expect(res.status).toBe(400);
    expect(backendCalls()).toHaveLength(0);
  });

  it("forwards nothing when there are no parameters", async () => {
    backend({ adminToken: { role: "admin" } });

    await getAlerts(req("/api/admin/alerts", "adminToken"));

    expect(forwarded()).toBe("http://backend.test/api/admin/alerts");
  });
});
