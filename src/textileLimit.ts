// Shared Textile rate limiter. Every Textile call goes through here so scans, trades and
// Convert together stay under Textile's ~60 requests/min, and a 429 is retried instead of failing a trade.
const LIMIT = Number(process.env.TEXTILE_RPM ?? '50')
const WINDOW_MS = 60_000
const stamps: number[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let queue: Promise<void> = Promise.resolve()

export const textileStats = { requests: 0, throttledMs: 0, retried429: 0, last429: null as string | null }

function slot(): Promise<void> {
  const next = queue.then(async () => {
    for (;;) {
      const now = Date.now()
      while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift()
      if (stamps.length < LIMIT) { stamps.push(now); return }
      await sleep(WINDOW_MS - (now - stamps[0]) + 50)
    }
  })
  queue = next.catch(() => {})
  return next
}

export async function limitedFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now()
    await slot()
    textileStats.throttledMs += Date.now() - t0
    textileStats.requests++
    const res = await fetch(...args)
    if (res.status !== 429 || attempt >= 2) return res
    textileStats.retried429++
    textileStats.last429 = new Date().toISOString()
    const ra = Number(res.headers.get('retry-after'))
    await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * (attempt + 1))
  }
}
