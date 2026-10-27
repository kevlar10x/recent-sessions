import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'recent-sessions'
const MINUTE = 60_000
const START = Date.parse('2026-10-26T12:00:00Z')

type Listed = {
  sessionId: string
  title: string
  isRunning: boolean
  lastActivityAt: string
  group: { id: string; name: string } | null
  link?: string
}

type App = { list: Listed[]; self: Listed; isOnScreen: boolean; calls: string[]; isMissing?: boolean }

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'recent',
  props: {
    title: 'Recent',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// What the person typing /recent in the desktop app's composer sends.
const RECENT = {
  command: 'recent',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString()

function session(id: string, group: string | null, minutes: number, isRunning = false): Listed {
  return {
    sessionId: id,
    title: `Session ${id}`,
    isRunning,
    lastActivityAt: at(minutes),
    group: group === null ? null : { id: `cg-${group}`, name: `Group ${group}` },
    link: `claude://claude.ai/epitaxy/${id}`,
  }
}

// Stands in for the engine and the desktop app's session tools.
function engine(on: On, app: App) {
  let isUp = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'recent' } }))
  // The app attaches a window only while this session is on screen.
  on('session.surfaces', () => ({ value: app.isOnScreen ? ['desktop'] : [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.detach', (_, e) => ({ clientId: e.clientId }))
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
    if (app.isMissing) throw new Error(`no MCP server named ${e.server}`)
    const answer = e.tool === 'list_sessions' ? app.list : app.self
    return { value: { content: [{ type: 'text', text: JSON.stringify(answer) }], isError: false } }
  })
}

async function open($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RECENT)
  await clock.settle()
}

const WINDOW = { surface: 'desktop', clientId: 'desktop:default' } as const

// Switching to another session and back, as the app reports it.
async function away($: Engine, app: App) {
  app.isOnScreen = false
  await $.session.detach({ ...WINDOW, reason: 'detach' })
}

async function back($: Engine, app: App) {
  app.isOnScreen = true
  await $.session.attach(WINDOW)
}

async function drawn($: Engine, surface: 'desktop' | 'terminal' = 'desktop') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const root = await ui.find({ type: 'Box' })
  const text = root?.text ?? (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return text
}

const before = (text: string, first: string, second: string) => text.indexOf(first) < text.indexOf(second)

test('groups and sessions are ordered by when they last finished', async ($, on) => {
  const clock = mock.clock(on, { now: START + 10 * MINUTE })
  mock.store(on)
  const app: App = {
    list: [session('a', 'one', 5), session('b', 'one', 1), session('c', 'two', 8), session('d', null, 3)],
    self: session('self', 'two', 2),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)

  const text = await drawn($)
  expect(before(text, 'Group two', 'Group one')).toBe(true)
  expect(before(text, 'Group one', 'Ungrouped')).toBe(true)
  expect(before(text, 'Session c', 'Session self')).toBe(true)
  expect(before(text, 'Session a', 'Session b')).toBe(true)
  expect(text).toContain('2m')
})

test('a finished session moves its whole group up, a working one keeps its place', async ($, on) => {
  const clock = mock.clock(on, { now: START + 10 * MINUTE })
  mock.store(on)
  const app: App = {
    list: [session('a', 'one', 9, true), session('b', 'one', 1), session('c', 'two', 9.5, true)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  expect(before(await drawn($), 'Group two', 'Group one')).toBe(true)

  // c keeps working (its activity moves on), a finishes after it was last seen.
  app.list = [session('a', 'one', 11), session('b', 'one', 1), session('c', 'two', 12, true)]
  await clock.advance(3000)

  const text = await drawn($)
  expect(before(text, 'Group one', 'Group two')).toBe(true)
  expect(before(text, 'Session a', 'Session b')).toBe(true)
  expect(text).toContain('working')
})

test('nothing is read while another session is on screen, and the list is read at once on return', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const app: App = { list: [session('a', 'one', 0)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await open($, clock)
  await away($, app)
  const count = app.calls.length
  await clock.advance(60_000)
  expect(app.calls.length).toBe(count)

  app.list = [session('a', 'one', 0), session('b', 'one', 1)]
  await back($, app)
  await clock.settle()
  expect(app.calls.length).toBeGreaterThan(count)
  expect(await drawn($)).toContain('Session b')
})

test('closing the panel stops the polling', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const app: App = { list: [session('a', 'one', 0)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await open($, clock)
  await $.command.run(RECENT)
  const count = app.calls.length
  await clock.advance(60_000)

  expect(app.calls.length).toBe(count)
})

test('a new session opens the panel when it was last left open', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on, { isWanted: true })
  const app: App = { list: [session('a', 'one', 0)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(await drawn($)).toContain('Session a')

  // /recent where it already shows closes it.
  await $.command.run(RECENT)
  const count = app.calls.length
  await clock.advance(60_000)
  expect(app.calls.length).toBe(count)
})

test('a session already running opens the panel on its next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  let isWanted = false
  on('store.get', (_, e) => ({ value: e.key === 'isWanted' ? isWanted : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const app: App = { list: [session('a', 'one', 0)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(app.calls.length).toBe(0)

  isWanted = true
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(await drawn($)).toContain('Session a')
})

test("a later finish saved by another session's panel is kept, not overwritten", async ($, on) => {
  const clock = mock.clock(on, { now: START + 10 * MINUTE })
  // The store every session shares, which the test writes to as another session would.
  const saved: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: saved[e.key] }))
  on('store.set', (_, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  const app: App = {
    list: [session('x', 'one', 5), session('w', 'two', 7)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  expect(before(await drawn($), 'Group two', 'Group one')).toBe(true)

  // While this session is off screen, x finishes at 9 and starts working again.
  // Another session's panel saw it finish and saved that; a new session appears.
  await away($, app)
  await clock.advance(10_000)
  saved.finishedAt = { ...(saved.finishedAt as Record<string, number>), x: START + 9 * MINUTE }
  app.list = [session('x', 'one', 12, true), session('w', 'two', 7), session('new', null, 1)]
  await back($, app)
  await clock.advance(10_000)

  expect((saved.finishedAt as Record<string, number>).x).toBe(START + 9 * MINUTE)
  expect(before(await drawn($), 'Group one', 'Group two')).toBe(true)
})

test('the own row of this session is read again after a prompt and after its turn ends', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const app: App = { list: [session('a', 'one', 0)], self: session('self', 'one', 0), isOnScreen: true, calls: [] }
  engine(on, app)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  await open($, clock)
  const selfReads = () => app.calls.filter(tool => tool === 'get_session').length

  // Idle and unchanged: not read again on every check.
  await clock.advance(16_000)
  const idle = selfReads()
  expect(idle).toBe(1)

  // A prompt here starts a turn: the next check reads it and shows it working.
  app.self = session('self', 'one', 1, true)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await clock.advance(8_000)
  expect(selfReads()).toBe(idle + 1)
  expect(await drawn($)).toContain('working')

  // The turn ends: read again until the app says it's done.
  app.self = session('self', 'one', 2)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000 } as never)
  await clock.advance(3_000)
  expect(await drawn($)).not.toContain('working')
})

test('when the list cannot be read the panel says why', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const app: App = { list: [], self: session('self', null, 0), isOnScreen: true, calls: [], isMissing: true }
  engine(on, app)
  await open($, clock)

  expect(await drawn($, 'terminal')).toContain('works only in its Code tab')
  expect(await drawn($, 'desktop')).toContain("Couldn't read your sessions from the app: ")
})
