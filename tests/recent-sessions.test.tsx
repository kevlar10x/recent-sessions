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

// The store every session's panel shares, which a test writes to as another
// session's panel would. `onSet` runs as this panel saves, before its save
// lands; `onGet` runs right after a read. Counts how often the panel lists the keys.
function sharedStore(
  on: On,
  saved: Record<string, unknown>,
  onSet?: (key: string) => void,
  onGet?: (key: string) => void,
) {
  const counts = { keys: 0 }
  on('store.get', (_, e) => {
    const value = saved[e.key]
    onGet?.(e.key)
    return { value }
  })
  on('store.set', (_, e) => {
    onSet?.(e.key)
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => {
    counts.keys += 1
    return { value: Object.keys(saved) }
  })
  return counts
}

const timesOf = (entry: unknown) => (entry as { times: Record<string, number> } | undefined)?.times

// The keys a panel saved under: `finished:<session>:<when it saved>`.
const keysOf = (saved: Record<string, unknown>, id: string) =>
  Object.keys(saved).filter(key => key.startsWith(`finished:${id}:`))
const ownEntry = (saved: Record<string, unknown>, id: string) => saved[keysOf(saved, id).at(-1) ?? '']

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
  on('store.keys', () => ({ value: [] }))
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
  const saved: Record<string, unknown> = {}
  sharedStore(on, saved)
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

test("an idle session's older list time doesn't replace a later saved finish", async ($, on) => {
  const clock = mock.clock(on, { now: START + 10 * MINUTE })
  const saved: Record<string, unknown> = { finishedAt: { x: START + 9 * MINUTE } }
  sharedStore(on, saved)
  // The list still shows x idle with an activity time older than the saved finish.
  const app: App = {
    list: [session('x', 'one', 5), session('w', 'two', 7)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  await clock.advance(10_000)

  expect((saved.finishedAt as Record<string, number>).x).toBe(START + 9 * MINUTE)
  expect(before(await drawn($), 'Group one', 'Group two')).toBe(true)
})

test("a finish another panel saves after this one's last read isn't written over", async ($, on) => {
  const clock = mock.clock(on, { now: START + 10 * MINUTE })
  const saved: Record<string, unknown> = {}
  // Right as this panel saves, another session's panel saves that x finished at
  // 9, in the shared key older versions used and in its own key.
  sharedStore(on, saved, key => {
    if (!key.startsWith('finished')) return
    const was = (saved.finishedAt as Record<string, number> | undefined) ?? {}
    saved.finishedAt = { ...was, x: START + 9 * MINUTE }
    saved['finished:other'] = { at: START + 10 * MINUTE, times: { x: START + 9 * MINUTE } }
  })
  const app: App = {
    list: [session('x', 'one', 5), session('w', 'two', 7)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)

  // x starts working again, and a minute later the panel reads what the others saved.
  app.list = [session('x', 'one', 12, true), session('w', 'two', 7)]
  await clock.advance(70_000)

  expect(timesOf(saved['finished:other'])?.x).toBe(START + 9 * MINUTE)
  expect(before(await drawn($), 'Group one', 'Group two')).toBe(true)
})

test("a working session's first sighting isn't saved, so it can't outrank a finish", async ($, on) => {
  const clock = mock.clock(on, { now: START + 12 * MINUTE })
  // Another panel saw z finish at 9; this one only ever sees it working.
  const saved: Record<string, unknown> = { 'finished:other': { at: START, times: { z: START + 9 * MINUTE } } }
  sharedStore(on, saved)
  const app: App = {
    list: [session('z', 'one', 12, true), session('w', 'two', 10)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)

  expect(timesOf(ownEntry(saved, 'self'))?.z).toBeUndefined()
  expect(before(await drawn($), 'Group two', 'Group one')).toBe(true)
})

test("a panel's saved finishes go once it hasn't saved for two weeks", async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const old = START - 15 * 24 * 60 * MINUTE
  const saved: Record<string, unknown> = {
    [`finished:gone:${old}`]: { at: old, times: { a: old } },
    [`finished:recent:${START - MINUTE}`]: { at: START - MINUTE, times: { a: START - MINUTE } },
  }
  sharedStore(on, saved)
  const app: App = { list: [session('a', 'one', -5)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await open($, clock)

  expect(keysOf(saved, 'gone')).toEqual([])
  expect(keysOf(saved, 'recent').length).toBe(1)
  expect(timesOf(ownEntry(saved, 'self'))?.a).toBe(START - 5 * MINUTE)
})

test('a panel that resumes while its old key is cleaned up keeps what it saves', async ($, on) => {
  const clock = mock.clock(on, { now: START + 12 * MINUTE })
  const old = START - 15 * 24 * 60 * MINUTE
  const stale = `finished:b:${old}`
  const fresh = `finished:b:${START + 12 * MINUTE}`
  const saved: Record<string, unknown> = { [stale]: { at: old, times: { x: old } } }
  // Panel b comes back right after this panel listed the keys and read b's old
  // key, or between those: it saves that x finished at 9 and drops its old key.
  let isResumed = false
  const resume = () => {
    if (isResumed) return
    isResumed = true
    saved[fresh] = { at: START + 12 * MINUTE, times: { x: START + 9 * MINUTE } }
    delete saved[stale]
  }
  sharedStore(on, saved, undefined, resume)
  const app: App = {
    list: [session('x', 'one', 12, true), session('w', 'two', 10)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  await clock.advance(70_000)

  expect(timesOf(saved[fresh])?.x).toBe(START + 9 * MINUTE)
})

test('a key from before 0.1.7 that is written during cleanup is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const old = START - 15 * 24 * 60 * MINUTE
  const saved: Record<string, unknown> = { 'finished:b': { at: old, times: { x: old } } }
  sharedStore(on, saved, undefined, key => {
    if (key === 'finished:b') saved[key] = { at: START, times: { x: START - MINUTE } }
  })
  const app: App = { list: [session('a', 'one', -5)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await open($, clock)
  await clock.advance(70_000)

  expect(timesOf(saved['finished:b'])?.x).toBe(START - MINUTE)
})

test('a panel keeps one key, and moves its key from before 0.1.7 onto it', async ($, on) => {
  const clock = mock.clock(on, { now: START + 12 * MINUTE })
  const saved: Record<string, unknown> = { 'finished:self': { at: START, times: { x: START + 9 * MINUTE } } }
  sharedStore(on, saved)
  const app: App = {
    list: [session('x', 'one', 12, true), session('w', 'two', 10)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  app.list = [session('x', 'one', 12, true), session('w', 'two', 12)]
  await clock.advance(10_000)

  expect('finished:self' in saved).toBe(false)
  expect(keysOf(saved, 'self').length).toBe(1)
  expect(timesOf(ownEntry(saved, 'self'))?.x).toBe(START + 9 * MINUTE)
})

test("other panels' saves are read once a minute while the panel stays open", async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const saved: Record<string, unknown> = {}
  const counts = sharedStore(on, saved)
  const app: App = { list: [session('a', 'one', 0, true)], self: session('self', null, 0), isOnScreen: true, calls: [] }
  engine(on, app)
  await open($, clock)
  await clock.advance(60_000)

  // A tick every 3 s while a session works, but the keys only at the start and once after a minute.
  expect(counts.keys).toBe(2)
  expect(app.calls.filter(tool => tool === 'list_sessions').length).toBeGreaterThan(15)
})

test("after a restart, a working session's saved finish stays in this panel's key", async ($, on) => {
  const clock = mock.clock(on, { now: START + 12 * MINUTE })
  // Saved before the restart: this panel saw x finish at 9; x has started again since.
  const saved: Record<string, unknown> = { 'finished:self': { at: START, times: { x: START + 9 * MINUTE } } }
  sharedStore(on, saved)
  const app: App = {
    list: [session('x', 'one', 12, true), session('w', 'two', 10)],
    self: session('self', 'three', 0),
    isOnScreen: true,
    calls: [],
  }
  engine(on, app)
  await open($, clock)
  await clock.advance(70_000)

  expect(timesOf(ownEntry(saved, 'self'))?.x).toBe(START + 9 * MINUTE)
  expect(before(await drawn($), 'Group two', 'Group one')).toBe(true)
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
