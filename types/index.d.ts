export type SessionRow = {
  id: string
  title: string
  /** The name of the directory the session started in (a worktree's project's). */
  project: string
  isWorktree?: boolean
  /** Epoch seconds of the first record, if it has a timestamp. */
  startedAt?: number
  /** Epoch seconds of the last write, for sorting. */
  updatedAt: number
  /** Which scan wrote the row; an older one is scanned again. */
  scan?: number
  branch?: string
  /** Model id the last answer came from, e.g. `claude-opus-5-5`. */
  model?: string
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  prNumber?: number
  prUrl?: string
  /** `claude-desktop`, `cli`, ... */
  entrypoint?: string
}

export type Listing = {
  rows: SessionRow[]
  error: string | null
  /** The machine's offset from UTC in seconds, so dates read as its own. */
  utcOffset?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-list': { listing: Listing | null }
  }
}
