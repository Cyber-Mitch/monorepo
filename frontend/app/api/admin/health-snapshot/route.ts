import { NextRequest } from "next/server"
import { proxyAdminGet } from "@/lib/server/adminProxy"

/** Admin-only (#1935): needs a signed-in admin, forwards that admin's own token, never the shared secret. */
export async function GET(request: NextRequest) {
  return proxyAdminGet(request, "/api/admin/health-snapshot")
}
