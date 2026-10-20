import { sessionStore, userStore } from '../models/authStore.js'

/** A session token for the admin test user created by `seedAdminSession`. */
export const ADMIN_TEST_TOKEN = 'test-token-admin-rbac'
export const adminAuthHeader = { Authorization: `Bearer ${ADMIN_TEST_TOKEN}` }

export interface SeededAdmin {
  id: string
  token: string
  header: { Authorization: string }
}

/**
 * Creates (or reuses) an admin user with a live session, for route tests that
 * used to send `x-admin-secret`. With no RBAC database configured,
 * `requirePermission` falls back to the legacy `admin` role, so this user holds
 * every permission. Pass `role: 'tenant'` for a user that holds none.
 */
export async function seedAdminSession(
  options: { email?: string; token?: string; role?: 'admin' | 'super_admin' | 'tenant' } = {},
): Promise<SeededAdmin> {
  const email = options.email ?? 'rbac-admin@example.com'
  const token = options.token ?? ADMIN_TEST_TOKEN
  const user = Object.assign(await userStore.getOrCreateByEmail(email), {
    role: options.role ?? 'admin',
  })
  await sessionStore.create(user.email, token)
  return { id: user.id, token, header: { Authorization: `Bearer ${token}` } }
}
