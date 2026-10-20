/**
 * Collects every route an Express app exposes, as `METHOD /path`, by walking its router stack.
 * Used by the OpenAPI drift guard (openapiCoverage.test.ts). Express 4 only keeps a mount path as a
 * regular expression plus its parameter names, so the path is rebuilt from those.
 */

import type { Express } from 'express'

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack?: Layer[] }
  name?: string
  handle?: { stack?: Layer[] }
  regexp?: RegExp & { fast_slash?: boolean; fast_star?: boolean }
  keys?: Array<{ name: string | number }>
}

/** Rebuilds the static mount path of a `router`/middleware layer, e.g. `/api/v1/admin/:userId`. */
export function mountPathOf(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return ''
  let source = layer.regexp.source
    .replace(/^\^/, '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\$$/, '')
  const keys = [...(layer.keys ?? [])]
  // Parameter groups look like `(?:([^\/]+?))`.
  source = source.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${keys.shift()?.name ?? 'param'}`)
  return source.replace(/\\\//g, '/').replace(/\\(.)/g, '$1')
}

export interface CollectedRoute {
  method: string
  path: string
}

function walk(stack: Layer[], prefix: string, out: CollectedRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) {
            out.push({ method: method.toUpperCase(), path: `${prefix}${p === '/' ? '' : p}` || '/' })
          }
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, `${prefix}${mountPathOf(layer)}`, out)
    }
  }
}

/** Every route mounted on the app. `app.all` registers one entry per method; `HEAD` and `OPTIONS` are dropped. */
export function collectRoutes(app: Express): CollectedRoute[] {
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? []
  const out: CollectedRoute[] = []
  walk(stack, '', out)
  return out.filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
}

/**
 * Key used to compare mounted routes with the spec: `METHOD /path`, with `:id`, `{id}` and any
 * parameter name reduced to `{}`, the trailing slash removed, and the `/v1` version segment dropped
 * (the spec documents the same operations under `/api/...` and `/api/v1/...`).
 */
export function routeKey(method: string, path: string): string {
  const normalized = path
    .replace(/\/{2,}/g, '/')
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, '{}')
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/^\/api\/v1(?=\/|$)/, '/api')
    .replace(/(.)\/$/, '$1')
  return `${method.toUpperCase()} ${normalized}`
}
