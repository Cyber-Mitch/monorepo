import { NextRequest } from "next/server"
import { intBetween, oneOf, proxyAdminGet, shortToken } from "@/lib/server/adminProxy"

/** Admin-only (#1935): needs a signed-in admin, forwards that admin's own token, never the shared secret. */
export async function GET(request: NextRequest) {
  return proxyAdminGet(request, "/api/admin/alerts", {
    severity: oneOf("critical", "high", "medium", "low"),
    status: oneOf("open", "resolved"),
    cursor: shortToken,
    limit: intBetween(1, 100),
  })
}
