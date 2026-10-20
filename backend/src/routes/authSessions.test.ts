import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTestAgent } from '../test-helpers.js'
import { sessionStore, userStore, otpChallengeStore, refreshTokenStore } from '../models/authStore.js'
import { _testOnly_clearAuthRateLimits } from '../middleware/authRateLimit.js'

vi.mock('../utils/tokens.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../utils/tokens.js')>()
  return {
    ...mod,
    generateOtp: () => '123456',
    generateToken: () => `tok-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
  }
})

type Agent = ReturnType<typeof createTestAgent>

interface Login {
  token: string
  refreshCookie: string
}

function refreshCookieFrom(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []
  const raw = cookies.find((c) => c.startsWith('refreshToken='))
  if (!raw) throw new Error('no refresh cookie')
  return raw.split(';')[0]!
}

async function login(agent: Agent, email: string): Promise<Login> {
  _testOnly_clearAuthRateLimits()
  await agent.post('/api/auth/request-otp').send({ email }).expect(200)
  const res = await agent.post('/api/auth/verify-otp').send({ email, otp: '123456' }).expect(200)
  return { token: res.body.token as string, refreshCookie: refreshCookieFrom(res) }
}

describe('Active session management (#1907)', () => {
  const emailA = 'sessions-a@example.com'
  const emailB = 'sessions-b@example.com'

  beforeEach(() => {
    sessionStore.clear()
    userStore.clear()
    otpChallengeStore.clear()
    refreshTokenStore.clear()
    _testOnly_clearAuthRateLimits()
  })

  it('lists active sessions and flags the current one', async () => {
    const agent = createTestAgent()
    const phone = await login(agent, emailA)
    const laptop = await login(agent, emailA)

    const res = await agent.get('/api/auth/sessions').set('Authorization', `Bearer ${laptop.token}`).expect(200)

    expect(res.body.sessions).toHaveLength(2)
    expect(res.body.sessions.filter((s: any) => s.current)).toHaveLength(1)

    const asPhone = await agent.get('/api/auth/sessions').set('Authorization', `Bearer ${phone.token}`).expect(200)
    const currentIdForPhone = asPhone.body.sessions.find((s: any) => s.current).id
    const currentIdForLaptop = res.body.sessions.find((s: any) => s.current).id
    expect(currentIdForPhone).not.toBe(currentIdForLaptop)
  })

  it('revoking a session kills its access token and refresh token on the next request', async () => {
    const agent = createTestAgent()
    const phone = await login(agent, emailA)
    const laptop = await login(agent, emailA)

    const list = await agent.get('/api/auth/sessions').set('Authorization', `Bearer ${laptop.token}`).expect(200)
    const phoneSession = list.body.sessions.find((s: any) => !s.current)

    await agent.delete(`/api/auth/sessions/${phoneSession.id}`).set('Authorization', `Bearer ${laptop.token}`).expect(200)

    await agent.get('/api/auth/me').set('Authorization', `Bearer ${phone.token}`).expect(401)
    await agent.post('/api/auth/refresh').set('Cookie', phone.refreshCookie).expect(401)
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${laptop.token}`).expect(200)
  })

  it("rejects revoking another user's session with 404 and leaves it intact", async () => {
    const agent = createTestAgent()
    const victim = await login(agent, emailB)
    const attacker = await login(agent, emailA)

    const victimList = await agent.get('/api/auth/sessions').set('Authorization', `Bearer ${victim.token}`).expect(200)
    const victimSessionId = victimList.body.sessions[0].id

    await agent.delete(`/api/auth/sessions/${victimSessionId}`).set('Authorization', `Bearer ${attacker.token}`).expect(404)
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${victim.token}`).expect(200)
  })

  it('DELETE /sessions?others=true keeps only the current device', async () => {
    const agent = createTestAgent()
    const a = await login(agent, emailA)
    const b = await login(agent, emailA)
    const c = await login(agent, emailA)

    const res = await agent.delete('/api/auth/sessions?others=true').set('Authorization', `Bearer ${b.token}`).expect(200)
    expect(res.body.revoked).toBe(2)

    await agent.get('/api/auth/me').set('Authorization', `Bearer ${a.token}`).expect(401)
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${c.token}`).expect(401)
    await agent.post('/api/auth/refresh').set('Cookie', a.refreshCookie).expect(401)
    await agent.get('/api/auth/me').set('Authorization', `Bearer ${b.token}`).expect(200)
    await agent.post('/api/auth/refresh').set('Cookie', b.refreshCookie).expect(200)
  })

  it('a refreshed session is still one device in the list', async () => {
    const agent = createTestAgent()
    const phone = await login(agent, emailA)
    await agent.post('/api/auth/refresh').set('Cookie', phone.refreshCookie).expect(200)

    const res = await agent.get('/api/auth/sessions').set('Authorization', `Bearer ${phone.token}`).expect(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].current).toBe(true)
  })

  it('requires authentication and a uuid session id', async () => {
    const agent = createTestAgent()
    await agent.get('/api/auth/sessions').expect(401)
    const a = await login(agent, emailA)
    await agent.delete('/api/auth/sessions/not-a-uuid').set('Authorization', `Bearer ${a.token}`).expect(400)
  })

  describe('admin force-logout', () => {
    it('forbids non-admins', async () => {
      const agent = createTestAgent()
      const victim = await login(agent, emailB)
      const user = await userStore.getByEmail(emailB)
      const other = await login(agent, emailA)

      await agent.get(`/api/admin/users/${user!.id}/sessions`).set('Authorization', `Bearer ${other.token}`).expect(403)
      await agent.delete(`/api/admin/users/${user!.id}/sessions`).set('Authorization', `Bearer ${other.token}`).expect(403)
      await agent.get('/api/auth/me').set('Authorization', `Bearer ${victim.token}`).expect(200)
    })

    it('lets an admin list and revoke every session of a user', async () => {
      const agent = createTestAgent()
      const v1 = await login(agent, emailB)
      const v2 = await login(agent, emailB)
      const victim = await userStore.getByEmail(emailB)

      const admin = await userStore.getOrCreateByEmail('sessions-admin@example.com')
      admin.role = 'admin'
      const adminLogin = await login(agent, 'sessions-admin@example.com')

      const list = await agent
        .get(`/api/admin/users/${victim!.id}/sessions`)
        .set('Authorization', `Bearer ${adminLogin.token}`)
        .expect(200)
      expect(list.body.sessions).toHaveLength(2)

      const res = await agent
        .delete(`/api/admin/users/${victim!.id}/sessions`)
        .set('Authorization', `Bearer ${adminLogin.token}`)
        .expect(200)
      expect(res.body.revoked).toBe(2)

      await agent.get('/api/auth/me').set('Authorization', `Bearer ${v1.token}`).expect(401)
      await agent.get('/api/auth/me').set('Authorization', `Bearer ${v2.token}`).expect(401)
      await agent.post('/api/auth/refresh').set('Cookie', v1.refreshCookie).expect(401)
      await agent.post('/api/auth/refresh').set('Cookie', v2.refreshCookie).expect(401)
    })

    it('404s for an unknown user', async () => {
      const agent = createTestAgent()
      const admin = await userStore.getOrCreateByEmail('sessions-admin@example.com')
      admin.role = 'admin'
      const adminLogin = await login(agent, 'sessions-admin@example.com')
      await agent
        .get('/api/admin/users/00000000-0000-4000-8000-000000000000/sessions')
        .set('Authorization', `Bearer ${adminLogin.token}`)
        .expect(404)
    })
  })
})
