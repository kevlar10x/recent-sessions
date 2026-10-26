// One session as the panel draws it.
export type Row = {
  id: string
  title: string
  // The app's claude:// link to the session; absent where the organization turned links off.
  link?: string
  isRunning: boolean
  // How long ago it finished ("now", "4m", "2h", "3d"), or "working".
  ago: string
}

// A sidebar group, or "Ungrouped", with its sessions newest first.
export type Group = {
  id: string
  name: string
  rows: Row[]
  // Sessions in the group past the ones drawn.
  hidden: number
}

export type Board = {
  groups: Group[]
  // Why the session list couldn't be read, as the app or engine said it.
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'recent-sessions': {
      board: Board | null
    }
  }
}
