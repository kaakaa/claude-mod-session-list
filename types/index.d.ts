export type SessionRow = {
  id: string
  title: string
  project: string
  /** Local time, `YYYY-MM-DD HH:MM`. */
  started: string
  updated: string
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
  /** The directory the session started in, `~` for the home directory. */
  path?: string
}

export type Listing = { rows: SessionRow[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'session-list': { listing: Listing | null }
  }
}
