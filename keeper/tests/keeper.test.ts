// windvane-keeper: a marker gone quiet while windvane is enabled reloads it
// through its revision option, at most MAX_REVIVES times in the window; a
// fresh marker, a missing one or a disabled windvane leaves it alone.
import { expect, mock, test } from 'claude-code/testing'

import { MAX_REVIVES, REVISION_KEY, STALE_SECS, markerTs, storeOf } from '../hooks/register'

const SID = 'kkkkkkkk-0000-4000-8000-00000000000k'
const STORE = 'C:/tmp/keeper-test-store'
const START = { cwd: 'E:/demo/proj', surface: 'terminal' as const, isInteractive: true }

test('the store and the marker are read as windvane writes them', () => {
  expect(storeOf(undefined, 'C:\\Users\\x', undefined)).toBe('C:/Users/x/.windvane')
  expect(storeOf('~/w', undefined, '/home/x')).toBe('/home/x/w')
  expect(markerTs('{"plugin":"windvane","ts":1791830412.7}')).toBe(1791830412.7)
  expect(markerTs('not json')).toBe(undefined)
})

test('a stale marker reloads windvane; a fresh one, a disabled windvane and the cap do not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_791_830_000_000 })
  let age = 5 // seconds since windvane last wrote the marker
  let markerThere = true
  let enabled = true
  const sets: string[] = []

  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: START.cwd }))
  on('env.get', ($, e) => ({ value: e.name === 'WINDVANE_DIR' ? STORE : undefined }))
  on('session.id', () => ({ value: SID }))
  on('fs.exists', ($, e) => ({ value: markerThere && e.path.replace(/\\/g, '/') === `${STORE}/sessions/${SID}.mod` }))
  on('fs.read', () => ({ value: JSON.stringify({ plugin: 'windvane', ts: clock.now() / 1000 - age }) }))
  on('config.list', () => ({ value: enabled ? [{ key: REVISION_KEY, label: 'Revision', kind: 'text', value: '' }] : [] }))
  on('config.set', ($, e) => {
    sets.push(String(e.key))
    return { value: e.value }
  })

  await $.session.start(START)
  // `claude plugin test .` at the repository root runs this file too, with
  // windvane as the plugin under test; the keeper's own run is
  // `claude plugin test ./keeper`.
  if (logs.some(l => l.startsWith('windvane:'))) return
  await clock.advance(15_000)
  expect(sets).toEqual([]) // fresh

  age = STALE_SECS + 10
  await clock.advance(15_000)
  expect([...sets, ...logs]).toEqual([REVISION_KEY, expect.stringContaining('reloaded it')])

  // It waits for the reload to settle before it looks again.
  await clock.advance(15_000)
  expect(sets.length).toBe(1)

  enabled = false
  await clock.advance(60_000)
  expect(sets.length).toBe(1) // windvane switched off: left off

  enabled = true
  for (let i = 0; i < 6; i++) await clock.advance(61_000)
  expect(sets.length).toBe(MAX_REVIVES) // the cap within the window

  markerThere = false
  await clock.advance(11 * 60_000)
  const before = sets.length
  await clock.advance(61_000)
  expect(sets.length).toBe(before) // no marker: windvane never ran here
})
