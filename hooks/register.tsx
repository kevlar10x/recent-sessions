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
// is read only while the panel is open and its session is on screen.

const PANE = 'recent'
const TITLE = 'Recent'
const SESSIONS = 'ccd_session_mgmt'
const WINDOW = 'ccd_window'
const board = atom({ plugin: 'recent-sessions', key: 'board' } as const, null)

const BUSY_MS = 3000 // a session is working: its finish shows within 3 s
const IDLE_MS = 8000 // nothing is working
const AWAY_MS = 5000 // this session is off screen: only check whether it's back
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
let timer: Timer | undefined
let shown = ''
// When each session last finished (ms), kept in $.store across sessions.
let finished: Record<string, number> | undefined

function textOf(result: McpToolResult) {
  const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined
  return block?.text ?? ''
}

async function call($: Engine, server: string, tool: string, args: Record<string, unknown>) {
  const result = await $.mcp.call(server, tool, args)
  if (result.isError) throw new Error(textOf(result) || `${tool} failed`)
  return JSON.parse(textOf(result)) as unknown
}

// The app answers with where this session shows; any failure counts as on screen.
async function isOnScreen($: Engine) {
  try {
    const layout = (await call($, WINDOW, 'get_window_layout', {})) as { this_session?: { on_screen?: boolean } }
    return layout.this_session?.on_screen !== false
  } catch {
    return true
  }
}

async function readSessions($: Engine) {
  const [others, self] = await Promise.all([
    call($, SESSIONS, 'list_sessions', { limit: LIST_LIMIT }),
    call($, SESSIONS, 'get_session', { session_id: 'self' }).catch(() => null),
  ])
  const list = Array.isArray(others) ? (others as Listed[]) : []
  return { list: self ? [self as Listed, ...list] : list, selfId: (self as Listed | null)?.sessionId }
}

function ago(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// A finished session takes its last activity as its finish time. A working one
// keeps the finish it had, so it doesn't jump up while it works; one never seen
// idle keeps the activity time it was first seen with.
function track(list: Listed[]) {
  const known = finished ?? {}
  const next: Record<string, number> = {}
  for (const session of list) {
    const active = Date.parse(session.lastActivityAt ?? '') || 0
    const before = known[session.sessionId]
    next[session.sessionId] = session.isRunning && before !== undefined ? before : active
  }
  const isChanged = JSON.stringify(next) !== JSON.stringify(known)
  finished = next
  return isChanged
}

function arrange(list: Listed[], selfId: string | undefined, now: number): Board {
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
          isSelf: session.sessionId === selfId,
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
    if (!(await isOnScreen($))) {
      wait = AWAY_MS
      return
    }
    if (finished === undefined) {
      const kept = await $.store.get('finishedAt')
      finished = kept !== null && typeof kept === 'object' ? (kept as Record<string, number>) : {}
    }
    const { list, selfId } = await readSessions($)
    if (track(list)) await $.store.set('finishedAt', finished)
    wait = list.some(session => session.isRunning) ? BUSY_MS : IDLE_MS
    await show($, arrange(list, selfId, await $.clock.now()))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await show($, { groups: [], error: reason.slice(0, 200) || 'unknown error' })
    wait = IDLE_MS
  } finally {
    isTicking = false
    if (isOpen) timer = $.clock.after(wait, () => void tick($))
  }
}

function startPolling($: Engine) {
  isOpen = true
  if (timer === undefined && !isTicking) void tick($)
}

function stopPolling() {
  isOpen = false
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
    // /recent itself toggles the pane: opening it here first would make it close.
    if (!isOpen && e.command?.name !== 'recent') await follow($)

    return next(e)
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
      return row.isSelf || link === undefined ? (
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
