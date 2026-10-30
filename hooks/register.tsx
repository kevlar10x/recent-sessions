import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, McpToolResult, Register, Timer } from 'claude-code'

import type { Board, Group, Row } from '../types'

// recent-sessions by kevlar10x, MIT: https://github.com/kevlar10x/recent-sessions
//
// A panel that lists the Code tab's sessions by when each last finished, in
// their sidebar groups. A group moves up as a whole when one of its sessions
// finishes, and a session that is still working keeps its place until it is
// done. The desktop app gives mods no way to reorder its own sidebar, so this
// is a second view of it. The list comes from the app's own session tools and
// is read only while the panel is open and an app window shows its session:
// the app detaches the window when you switch to another session.

const PANE = 'recent'
const TITLE = 'Recent'
const SESSIONS = 'ccd_session_mgmt'
const board = atom({ plugin: 'recent-sessions', key: 'board' } as const, null)

const BUSY_MS = 3000 // a session is working: its finish shows within 3 s
const IDLE_MS = 8000 // nothing is working
const SELF_MS = 30000 // this session's own row, while nothing says it changed
const OTHERS_MS = 60000 // what the other panels saved, while this one stays open
const KEY = 'finished:' // each panel saves the finishes it saw under KEY + its session id + ':' + when it saved
const LEGACY_KEY = 'finishedAt' // the one shared key before 0.1.5, still read for its times
const KEEP_MS = 14 * 24 * 60 * 60 * 1000 // a key goes once it's this old
const REFRESH_MS = 24 * 60 * 60 * 1000 // an open panel saves at least this often, so its key stays
const LIST_LIMIT = 60
const PER_GROUP = 8
const LINK = /^claude:\/\/claude\.ai\/epitaxy\/[\w-]+$/

// A row of the app's list_sessions / get_session answer, the fields used here.
type Listed = {
  sessionId: string
  title?: string
  isRunning?: boolean
  lastActivityAt?: string
  group?: { id: string; name: string } | null
  link?: string
}

let isOpen = false
let isTicking = false
let isPaused = false
let timer: Timer | undefined
let shown = ''
// This session's own row: list_sessions leaves it out, so it's read on its own,
// and only when it can have changed (see wantsSelf).
let self: Listed | undefined
let selfReadAt = 0
let isSelfStale = true
// When each session last finished (ms), as the panel shows it.
let finished: Record<string, number> | undefined
// The finishes this session's panel has seen itself, which it alone saves, so no
// other panel's save can ever be written over.
let observed: Record<string, number> = {}
// The keys this panel saved under before, which go once a newer save is down.
let ownKeys: string[] = []
let savedJson = ''
let savedAt = 0
// When a running session no panel has seen finish was first seen. Kept here
// only: a first sighting isn't a finish and mustn't outrank one.
let firstSeen: Record<string, number> = {}
// The finishes every panel has saved, the latest for each session, and when
// they were last read.
let saved: Record<string, number> = {}
let savedReadAt: number | undefined

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

async function call($: Engine, server: string, tool: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(server, tool, args)
  if (result.isError) throw new Error(textOf(result) || `${tool} failed`)
  return JSON.parse(textOf(result)) as unknown
}

// The own row changes when a prompt starts a turn, when the turn ends, while it
// works, or when it is renamed or moved to another group, which nothing reports:
// that last case shows within SELF_MS.
function wantsSelf(now: number) {
  return isSelfStale || self === undefined || self.isRunning === true || now - selfReadAt >= SELF_MS
}

async function readSessions($: Engine, now: number) {
  const [others, fresh] = await Promise.all([
    call($, SESSIONS, 'list_sessions', { limit: LIST_LIMIT }),
    wantsSelf(now) ? call($, SESSIONS, 'get_session', { session_id: 'self' }).catch(() => null) : undefined,
  ])
  if (fresh) {
    self = fresh as Listed
    selfReadAt = now
    isSelfStale = false
  }
  const list = Array.isArray(others) ? (others as Listed[]) : []
  return self ? [self, ...list] : list
}

function ago(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// When a key was saved, from its name. Keys from before 0.1.7 don't carry it.
function savedTime(key: string) {
  const at = Number(key.slice(key.lastIndexOf(':') + 1))
  return Number.isFinite(at) ? at : undefined
}

// Reads what every panel saved and keeps the latest finish for each session:
// finish times only move forward, so what was read before stays. A key older
// than KEEP_MS is removed on the way. Its age is in its name and a save never
// reuses a key, so this can't remove a save made since: the store has no way to
// delete only if unchanged. An older key is rewritten in place, so only its own
// panel removes it.
async function readSaved($: Engine, now: number, ownKey: string | undefined) {
  const times: Record<string, number> = { ...saved }
  const add = (more: unknown) => {
    if (more === null || typeof more !== 'object') return
    for (const [id, at] of Object.entries(more)) {
      if (typeof at === 'number' && at > (times[id] ?? -Infinity)) times[id] = at
    }
  }
  const own: string[] = []
  for (const key of await $.store.keys()) {
    if (key === LEGACY_KEY) add(await $.store.get(key))
    if (!key.startsWith(KEY)) continue
    const isOwn = key === ownKey || key.startsWith(`${ownKey}:`)
    const at = savedTime(key)
    if (isOwn) own.push(key)
    else if (at !== undefined && now - at > KEEP_MS) {
      await $.store.delete(key)
      continue
    }
    const entry = (await $.store.get(key)) as { at?: unknown; times?: unknown } | undefined
    if (!isOwn && at === undefined && (typeof entry?.at !== 'number' || now - entry.at > KEEP_MS)) continue
    add(entry?.times)
    // This panel's own key holds what it saw before a restart or reload: take it
    // back as its own, or the next save would drop finishes of sessions now working.
    if (isOwn && entry?.times !== null && typeof entry?.times === 'object') {
      for (const [id, at] of Object.entries(entry.times)) {
        if (typeof at === 'number' && at > (observed[id] ?? -Infinity)) observed[id] = at
      }
    }
  }
  saved = times
  savedReadAt = now
  ownKeys = own
}

// A finished session takes the latest finish any panel saw, its last activity
// included. A working one keeps the finish it had, so it doesn't jump up while
// it works; one no panel has seen finish keeps the time it was first seen at.
function track(list: Listed[]) {
  const shown: Record<string, number> = {}
  const mine: Record<string, number> = {}
  const first: Record<string, number> = {}
  for (const session of list) {
    const id = session.sessionId
    const active = Date.parse(session.lastActivityAt ?? '') || 0
    const known = Math.max(saved[id] ?? -Infinity, observed[id] ?? -Infinity)
    if (!session.isRunning) {
      mine[id] = Math.max(observed[id] ?? -Infinity, active)
      shown[id] = Math.max(known, active)
    } else if (known > -Infinity) {
      if (observed[id] !== undefined) mine[id] = observed[id]
      shown[id] = known
    } else {
      first[id] = firstSeen[id] ?? active
      shown[id] = first[id]
    }
  }
  observed = mine
  firstSeen = first
  finished = shown
}

// Saves the finishes this panel saw under a new key, when they changed, then
// drops its older keys.
async function save($: Engine, now: number, ownKey: string | undefined) {
  const json = JSON.stringify(observed)
  if (ownKey === undefined || (json === savedJson && now - savedAt < REFRESH_MS)) return
  const key = `${ownKey}:${now}`
  await $.store.set(key, { at: now, times: observed })
  savedJson = json
  savedAt = now
  const old = ownKeys.filter(one => one !== key)
  ownKeys = [key]
  for (const one of old) await $.store.delete(one)
}

function arrange(list: Listed[], now: number): Board {
  const at = (session: Listed) => finished?.[session.sessionId] ?? 0
  const groups = new Map<string, { id: string; name: string; members: Listed[]; top: number }>()
  for (const session of list) {
    const id = session.group?.id ?? 'ungrouped'
    const group = groups.get(id) ?? { id, name: session.group?.name ?? 'Ungrouped', members: [], top: 0 }
    group.members.push(session)
    group.top = Math.max(group.top, at(session))
    groups.set(id, group)
  }

  const ordered = [...groups.values()].sort((a, b) => b.top - a.top || a.name.localeCompare(b.name))
  return {
    groups: ordered.map((group): Group => {
      const members = group.members.sort((a, b) => at(b) - at(a))
      const rows = members.slice(0, PER_GROUP).map(
        (session): Row => ({
          id: session.sessionId,
          title: session.title || 'Untitled session',
          link: session.link !== undefined && LINK.test(session.link) ? session.link : undefined,
          isRunning: session.isRunning === true,
          ago: session.isRunning ? 'working' : ago(now - at(session)),
        }),
      )
      return { id: group.id, name: group.name, rows, hidden: members.length - rows.length }
    }),
  }
}

// Writes the board only when what it draws changed, so an unchanged tick redraws nothing.
async function show($: Engine, next: Board) {
  const json = JSON.stringify(next)
  if (json === shown) return
  shown = json
  await update($, board, () => next)
}

async function tick($: Engine) {
  timer = undefined
  if (!isOpen || isTicking) return
  isTicking = true
  let wait = IDLE_MS
  try {
    // With no app window attached nothing draws the panel: stop until one attaches.
    if ((await $.session.surfaces()).length === 0) {
      isPaused = true
      return
    }
    const now = await $.clock.now()
    const list = await readSessions($, now)
    const ownKey = self === undefined ? undefined : `${KEY}${self.sessionId}`
    // The list shows every idle session's finish to every panel; what the
    // others saved adds only finishes this one missed, so it's read when the
    // panel starts or comes back, and once a minute in between.
    if (savedReadAt === undefined || now - savedReadAt >= OTHERS_MS) await readSaved($, now, ownKey)
    track(list)
    await save($, now, ownKey)
    wait = list.some(session => session.isRunning) ? BUSY_MS : IDLE_MS
    await show($, arrange(list, now))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await show($, { groups: [], error: reason.slice(0, 200) || 'unknown error' })
    wait = IDLE_MS
  } finally {
    isTicking = false
    if (isOpen && !isPaused) timer = $.clock.after(wait, () => void tick($))
  }
}

function startPolling($: Engine) {
  isOpen = true
  isPaused = false
  // Other panels may have saved finishes while this one was closed or away.
  savedReadAt = undefined
  if (timer === undefined && !isTicking) void tick($)
}

function stopPolling() {
  isOpen = false
  timer?.cancel()
  timer = undefined
}

// Nothing draws the panel until a window attaches again, so no timer runs meanwhile.
function pause() {
  isPaused = true
  timer?.cancel()
  timer = undefined
}

async function openSession($: Engine, link: string) {
  if (!LINK.test(link)) return
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  try {
    await $.process.run(isWindows ? ['explorer.exe', link] : ['open', link], { timeoutMs: 10000 })
  } catch {
    $.ui.toast("Couldn't open that session. Open it from the sidebar.")
  }
}

function fit(text: string, room: number) {
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

// Opens the pane where it was last left open in any session, and keeps an open
// one (a reload keeps it) polling.
async function follow($: Engine) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp && (await $.store.get('isWanted')) !== true) return
  if (!isUp) void $.ui.open({ id: PANE, title: TITLE })
  startPolling($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'recent', description: 'Show or hide the Recent sessions panel' })
    const result = await next(e)
    await follow($)

    return result
  })

  // A session that was already running when the panel was opened elsewhere gets it on its next prompt.
  on('prompt.submit', async ($, e, next) => {
    isSelfStale = true
    // /recent itself toggles the pane: opening it here first would make it close.
    if (!isOpen && e.command?.name !== 'recent') await follow($)

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    isSelfStale = true

    return next(e)
  })

  // Switching to another session detaches its window: stop reading until it's back.
  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    if (isOpen && (await $.session.surfaces()).length === 0) pause()

    return result
  })

  // An app window attached again: read the list now rather than at the next timer.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (isOpen && isPaused) startPolling($)

    return result
  })

  on('command.run', { command: 'recent' }, async $ => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the Recent panel.' }
    }

    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) return { text: `The Recent panel couldn't open here: ${opened.reason}.` }
    await $.store.set('isWanted', true)
    startPolling($)

    return { text: 'Opened the Recent panel. Run /recent again to close it.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    stopPolling()
    if (e.origin.kind !== 'unload') await $.store.set('isWanted', false)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, board)

    if (current === null) return <Text dimColor>Reading your sessions…</Text>
    if (current.error !== undefined) {
      // Outside the desktop app the session tools don't exist; inside it, a failure is worth its reason.
      return e.surface === 'desktop' ? (
        <Text dimColor>Couldn't read your sessions from the app: {current.error}</Text>
      ) : (
        <Text dimColor>The session list comes from the Claude desktop app, so this panel works only in its Code tab.</Text>
      )
    }
    if (current.groups.length === 0) return <Text dimColor>No sessions yet.</Text>

    const width = Math.max(20, e.props.bodyColumns)
    const line = (row: Row) => {
      const title = fit(row.title, width - row.ago.length - 1)
      // Working in Claude's color, a finish under a minute old in green, the rest dim.
      const when = row.isRunning ? (
        <Text color="claude">{row.ago}</Text>
      ) : row.ago === 'now' ? (
        <Text color="success">{row.ago}</Text>
      ) : (
        <Text dimColor>{row.ago}</Text>
      )
      const link = row.link
      // This session's own row is a button too, so every row lines up; pressing it shows this session.
      return link === undefined ? (
        <Text>
          {title} {when}
        </Text>
      ) : (
        <Button key={row.id} plain onPress={() => void openSession($, link)}>
          {title} {when}
        </Button>
      )
    }

    return (
      <Box flexDirection="column">
        {current.groups.map((group, index) => (
          <Box key={group.id} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <Text bold wrap="truncate-end">
              {group.name}
            </Text>
            {group.rows.map(line)}
            {group.hidden > 0 && <Text dimColor>+{group.hidden} more</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
