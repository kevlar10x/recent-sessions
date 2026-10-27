import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// How many calls the open panel makes to the desktop app per minute, by state.
// Before 0.1.3 it was 60 with a session working, 24 idle and 12 while another
// session was on screen; a change that raises a count should be a deliberate one.

const MINUTE = 60_000
const START = Date.parse('2026-10-27T12:00:00Z')

const RECENT = {
  command: 'recent',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

type App = { isRunning: boolean; isAttached: boolean; calls: string[] }

function session(id: string, isRunning: boolean) {
  return {
    sessionId: id,
    title: `Session ${id}`,
    isRunning,
    lastActivityAt: new Date(START).toISOString(),
    group: { id: 'cg-one', name: 'Group one' },
    link: `claude://claude.ai/epitaxy/${id}`,
  }
}

function engine(on: On, app: App) {
  let isUp = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'recent' } }))
  on('session.surfaces', () => ({ value: app.isAttached ? ['desktop'] : [] }))
  on('ui.open', () => {
    isUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isUp = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'recent', title: 'Recent', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('mcp.call', (_, e) => {
    app.calls.push(e.tool)
    const answer = e.tool === 'list_sessions' ? [session('a', app.isRunning), session('b', false)] : session('self', false)
    return { value: { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: false } }
  })
}

const states = [
  { name: 'on screen, a session working', isRunning: true, isAttached: true, perMinute: 22 },
  { name: 'on screen, nothing working', isRunning: false, isAttached: true, perMinute: 10 },
  { name: 'another session on screen', isRunning: false, isAttached: false, perMinute: 0 },
] as const

for (const state of states) {
  test(`calls per minute: ${state.name}`, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    mock.store(on)
    const app: App = { isRunning: state.isRunning, isAttached: state.isAttached, calls: [] }
    engine(on, app)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.command.run(RECENT)
    await clock.settle()
    // Settle into the state, then count one full minute.
    await clock.advance(MINUTE)
    const before = app.calls.length
    await clock.advance(MINUTE)
    expect(app.calls.length - before).toBe(state.perMinute)
  })
}

test('an app window attaching wakes a paused panel at once', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const app: App = { isRunning: false, isAttached: false, calls: [] }
  engine(on, app)
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RECENT)
  await clock.advance(MINUTE)
  expect(app.calls.length).toBe(0)

  app.isAttached = true
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  expect(app.calls).toContain('list_sessions')
})
