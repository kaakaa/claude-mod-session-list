import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Listing, SessionRow } from '../types'

const PANE = 'session-list'
const SCAN = 4
const listing = atom({ plugin: 'session-list', key: 'listing' } as const, null)

// The first line is "TZ <offset>" (`date +%z`, e.g. +0900). Then one line per
// transcript: a grep pass pulls the fields out and awk keeps the last value of
// each (the first for the start, the entrypoint and the cwd), tab-separated.
// A transcript whose "id:mtime" is in $KNOWN has not changed since the last
// scan: it prints "KEEP <id>" and the module reuses the row it holds.
const SCRIPT = `
printf 'TZ\\t%s\\n' "$(date +%z)"
for f in "$HOME"/.claude/projects/*/*.jsonl; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .jsonl)
  m=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
  case " $KNOWN " in *" $id:$m "*) printf 'KEEP\\t%s\\n' "$id"; continue;; esac
  rest=$(grep -oE '"(timestamp|entrypoint|cwd|customTitle|lastPrompt|gitBranch|prUrl)":"[^"]*"|"model":"claude-[^"]*"|"(totalCostUSD|totalLinesAdded|totalLinesRemoved|prNumber)":[0-9.]+' "$f" | awk -F'"' '
    { k = $2; v = ($3 == ":") ? $4 : substr($3, 2) }
    k == "timestamp" || k == "entrypoint" || k == "cwd" { if (!(k in first)) first[k] = v; next }
    { last[k] = v }
    END {
      t = last["customTitle"]; if (t == "") t = last["lastPrompt"]
      printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s", first["timestamp"], t, last["gitBranch"], last["model"], last["totalCostUSD"], last["totalLinesAdded"], last["totalLinesRemoved"], last["prNumber"], last["prUrl"], first["entrypoint"], first["cwd"]
    }')
  iso=\${rest%%\t*}
  s=""
  [ -n "$iso" ] && s=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "\${iso%%.*}" '+%s' 2>/dev/null || date -d "$iso" '+%s')
  printf '%s\\t%s\\t%s\\t%s\\n' "$id" "$m" "$s" "\${rest#*\t}"
done
`

// "/…/src/app" → "app"; a worktree's "/…/src/app/.claude/worktrees/fix-x" is
// the project's too, "app", marked as a worktree.
function directory(cwd: string | undefined) {
  if (!cwd) return { project: '?', isWorktree: false }

  const [main = cwd, worktree] = cwd.split('/.claude/worktrees/')

  return {
    project: main.split('/').filter(Boolean).slice(-1)[0] ?? main,
    isWorktree: worktree !== undefined,
  }
}

const ORIGIN: Record<string, string> = {
  'claude-desktop': 'Desktop',
  cli: 'CLI',
  'claude-vscode': 'VS Code',
  'sdk-ts': 'SDK',
  'sdk-py': 'SDK',
}

function originName(entrypoint: string | undefined) {
  return entrypoint ? (ORIGIN[entrypoint] ?? entrypoint) : undefined
}

const num = (text: string | undefined) => (text ? Number(text) : undefined)
const str = (text: string | undefined) => (text ? text : undefined)

// "+0900" → 32400
function offsetSeconds(tz: string | undefined) {
  const [, sign, hours, minutes] = /^([+-])(\d{2})(\d{2})$/.exec(tz ?? '') ?? []
  if (!sign) return 0

  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60)
}

function parse(stdout: string, known: readonly SessionRow[]): Listing {
  const byId = new Map(known.map(row => [row.id, row]))
  let utcOffset = 0
  const rows = stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line): SessionRow[] => {
      const f = line.split('\t')

      if (f[0] === 'TZ') {
        utcOffset = offsetSeconds(f[1])

        return []
      }
      if (f[0] === 'KEEP') {
        const kept = byId.get(f[1] ?? '')

        return kept ? [kept] : []
      }

      return [{
        id: f[0] ?? '',
        updatedAt: Number(f[1] ?? 0),
        startedAt: num(f[2]),
        scan: SCAN,
        title: f[3] || '(untitled)',
        branch: str(f[4]),
        model: str(f[5]),
        costUsd: num(f[6]),
        linesAdded: num(f[7]),
        linesRemoved: num(f[8]),
        prNumber: num(f[9]),
        prUrl: str(f[10]),
        entrypoint: str(f[11]),
        ...directory(str(f[12])),
      }]
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return { rows, error: null, utcOffset }
}

// A day number on the machine's own calendar.
const dayOf = (epoch: number, offset: number) => Math.floor((epoch + offset) / 86400)

// Today "14:05", this year "10/8", before that "2025/10/8": the same words for
// a start and an end, so a span reads the same way at both ends.
function when(epoch: number, now: number, offset: number) {
  const local = new Date((epoch + offset) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')

  if (dayOf(epoch, offset) === dayOf(now, offset)) {
    return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  }

  const date = `${local.getUTCMonth() + 1}/${local.getUTCDate()}`
  const thisYear = new Date((now + offset) * 1000).getUTCFullYear()

  return local.getUTCFullYear() === thisYear ? date : `${local.getUTCFullYear()}/${date}`
}

// When the session ran: "10/8 → 14:05". One day's session names its day once,
// unless it is today's, which is told by its hours.
function span(row: SessionRow, now: number, offset: number) {
  const end = when(row.updatedAt, now, offset)
  if (row.startedAt === undefined) return end

  const start = when(row.startedAt, now, offset)
  const isOneDay = dayOf(row.startedAt, offset) === dayOf(row.updatedAt, offset)
  const isToday = dayOf(row.updatedAt, offset) === dayOf(now, offset)

  return isOneDay && !isToday ? end : `${start} → ${end}`
}

// "claude-opus-5-5" → "Opus 5.5"
function modelName(id: string | undefined) {
  if (!id) return undefined
  const [family = '', ...version] = id.replace(/^claude-/, '').split('-')

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim()
}

function section(epoch: number, now: number, offset: number) {
  const days = dayOf(now, offset) - dayOf(epoch, offset)
  if (days === 0) return 'Today'
  if (days < 7) return 'This week'

  return 'Earlier'
}

async function copyId($: EngineInterface, id: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text: id, surface })
  $.ui.toast(copied.isCopied ? `Copied session ID ${id.slice(0, 8)}…` : 'Could not copy')
}

async function refresh($: EngineInterface) {
  let next: Listing
  // Rows an older scan wrote lack the newer fields: scan those again.
  const known = ((await read($, listing))?.rows ?? []).filter(row => row.scan === SCAN)
  const KNOWN = known.map(row => `${row.id}:${row.updatedAt}`).join(' ')

  try {
    const run = await $.process.run(['sh', '-c', SCRIPT], {
      timeoutMs: 60_000,
      env: { KNOWN, LC_ALL: 'C' },
    })
    next =
      run.exitCode === 0
        ? parse(run.stdout, known)
        : { rows: [], error: run.stderr.trim().split('\n')[0] ?? 'listing failed' }
  } catch (error) {
    next = { rows: [], error: String(error) }
  }

  await update($, listing, () => next)

  return next
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: "List this machine's Claude Code sessions in a pane",
    })

    return next(e)
  })

  // The pane opens on what was held; the scan redraws it when it is done.
  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Claude sessions' })
    void refresh($)

    return { text: 'Sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const held = await read($, listing)
    // Rows an older version scanned lack what this one draws: show none of
    // them until the scan that replaces them is done.
    const state = held?.rows.some(row => row.scan !== SCAN) ? null : held

    const refreshButton = (
      <Button key="refresh" label="↻ Refresh" plain dimColor onPress={() => refresh($)} />
    )

    if (state === null) {
      return (
        <Box flexDirection="row" justifyContent="space-between" paddingX={2} paddingY={1}>
          <Text dimColor>Scanning sessions...</Text>
          {refreshButton}
        </Box>
      )
    }
    if (state.error) return <Text color="error">Could not list sessions: {state.error}</Text>

    const now = Math.floor((await $.clock.now()) / 1000)
    const offset = state.utcOffset ?? 0
    const total = state.rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    const groups = ['Today', 'This week', 'Earlier']
      .map(name => ({
        name,
        rows: state.rows.filter(row => section(row.updatedAt, now, offset) === name),
      }))
      .filter(group => group.rows.length > 0)

    return (
      <Box flexDirection="column" width="100%" paddingX={2} paddingY={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
          <Box flexDirection="column">
            <Text size="title" weight="bold">
              Sessions
            </Text>
            <Text size="caption" dimColor>
              {state.rows.length} sessions on this machine · ${total.toFixed(2)} total
            </Text>
          </Box>
          {refreshButton}
        </Box>

        {state.rows.length === 0 && <Text dimColor>No sessions found.</Text>}

        {groups.map(group => (
          <Box key={`group-${group.name}`} flexDirection="column" gap={1}>
            <Text size="footnote" weight="semibold" color="subtle">
              {group.name.toUpperCase()} · {group.rows.length}
            </Text>
            {group.rows.map(row => (
              <Box
                key={`row-${row.id}`}
                flexDirection="column"
                width="100%"
                borderStyle="round"
                borderColor="subtle"
                paddingX={1}
              >
                {/* What it is and when it ran. */}
                <Box flexDirection="row" gap={1} alignItems="center">
                  {originName(row.entrypoint) && (
                    <Text
                      size="caption"
                      weight="semibold"
                      color={row.entrypoint === 'cli' ? 'suggestion' : 'claude'}
                    >
                      {originName(row.entrypoint)}
                    </Text>
                  )}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text weight="semibold" wrap="truncate-end">
                      {row.title}
                    </Text>
                  </Box>
                  <Text size="caption" dimColor tabular>
                    {span(row, now, offset)}
                  </Text>
                  <Button
                    key={`copy-${row.id}`}
                    label="⧉"
                    plain
                    dimColor
                    onPress={press => copyId($, row.id, press.surface)}
                  />
                </Box>
                {/* Where it ran and what it changed on the left, what it cost on the right. */}
                <Box flexDirection="row" gap={2} alignItems="center">
                  <Text size="caption" dimColor wrap="truncate-end">
                    📁 {row.project}
                    {row.isWorktree ? ' (worktree)' : ''}
                  </Text>
                  {row.branch && row.branch !== 'HEAD' && (
                    <Text size="caption" dimColor wrap="truncate-end">
                      ⎇ {row.branch}
                    </Text>
                  )}
                  {(row.linesAdded ?? 0) + (row.linesRemoved ?? 0) > 0 && (
                    <Text size="caption">
                      <Text color="diffAdded">+{row.linesAdded ?? 0}</Text>{' '}
                      <Text color="diffRemoved">−{row.linesRemoved ?? 0}</Text>
                    </Text>
                  )}
                  {row.prUrl && <Link href={row.prUrl} label={`PR #${row.prNumber ?? ''}`} />}
                  <Box flexGrow={1} />
                  <Text size="caption" dimColor tabular>
                    {[
                      modelName(row.model),
                      row.costUsd !== undefined ? `$${row.costUsd.toFixed(2)}` : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
