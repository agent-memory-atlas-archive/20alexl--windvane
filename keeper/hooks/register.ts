// windvane-keeper: brings windvane back after Claude Code unloads it.
//
// Claude Code runs every plugin's hooks module in one worker. When the
// worker misses its five-second heartbeat, Claude Code unloads the plugin
// whose hook was running, and that plugin's tools go with it until the
// person runs /reload-plugins. windvane hooks nearly every event, so it is
// the one most often caught; a session then ran on to 85% of its compaction
// point with no compact_now (2026-10-12).
//
// windvane's mod rewrites a marker (<store>/sessions/<session>.mod, with the
// time in seconds) every ten seconds while it is loaded. This keeper reads
// that marker every fifteen seconds. Gone quiet for STALE_SECS while
// windvane is still enabled (its rows are in /config), the keeper changes
// windvane's hidden `revision` option: a change to a plugin's options
// reloads it, an unloaded one included (tested 2026-10-12), and windvane's
// tools come back. At most MAX_REVIVES in REVIVE_WINDOW_MS, so a windvane
// that keeps failing is left alone; a session that never had windvane (no
// marker) is never touched.
//
// The keeper does as little as it can, so it is never the plugin a stall
// is blamed on.
import type { Register } from 'claude-code'

export const CHECK_EVERY_MS = 15_000
export const STALE_SECS = 45
export const SETTLE_MS = 60_000
export const MAX_REVIVES = 3
export const REVIVE_WINDOW_MS = 10 * 60_000
export const REVISION_KEY = 'windvane.revision'

// windvane's store: WINDVANE_DIR (a leading ~ is the home folder), else
// .windvane under the home folder.
export function storeOf(dir: string | undefined, userProfile: string | undefined, home: string | undefined): string {
  const h = (userProfile || home || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const d = (dir || '').trim()
  const s = d ? (d.startsWith('~') ? h + d.slice(1) : d) : `${h}/.windvane`
  return s.replace(/\\/g, '/').replace(/\/+$/, '')
}

// The marker's time in seconds, or undefined when it holds none.
export function markerTs(text: string): number | undefined {
  try {
    const v: unknown = JSON.parse(text)
    const ts = typeof v === 'object' && v !== null ? (v as { ts?: unknown }).ts : undefined
    return typeof ts === 'number' && ts > 0 ? ts : undefined
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  let marker = ''
  let started = false
  let busy = false
  let settleUntil = 0
  const revives: number[] = []

  on('session.start', async ($, e, next) => {
    const done = await next(e)
    if (started) return done
    started = true
    const store = storeOf(await $.env.get('WINDVANE_DIR'), await $.env.get('USERPROFILE'), await $.env.get('HOME'))
    marker = `${store}/sessions/${await $.session.id()}.mod`

    const check = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const now = await $.clock.now()
        if (now < settleUntil) return
        if (!(await $.fs.exists(marker))) return // windvane never ran in this session
        const ts = markerTs(await $.fs.read(marker))
        if (ts === undefined || now / 1000 - ts < STALE_SECS) return
        while (revives.length && now - (revives[0] ?? 0) > REVIVE_WINDOW_MS) revives.shift()
        if (revives.length >= MAX_REVIVES) return
        const rows = await $.config.list()
        if (!rows.some(r => r.key === REVISION_KEY)) return // windvane is not enabled here
        revives.push(now)
        settleUntil = now + SETTLE_MS
        await $.config.set({ key: REVISION_KEY, value: String(Math.round(now)) })
        $.ui.log(`windvane-keeper: windvane went quiet for ${Math.round(now / 1000 - ts)} s; reloaded it`)
      } catch (err) {
        $.ui.log(`windvane-keeper: check failed: ${String(err)}`, { to: 'debug' })
      } finally {
        busy = false
      }
    }
    $.clock.every(CHECK_EVERY_MS, () => {
      void check()
    })
    return done
  })
}
