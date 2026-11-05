import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Listing, SessionRow } from '../types'

const PANE = 'session-list'
const SCAN = 3
const listing = atom({ plugin: 'session-list', key: 'listing' } as const, null)

// One grep pass per transcript pulls the fields out; awk keeps the last value
// of each (the first for the start and the entrypoint) and prints them
// tab-separated, the start as ISO. The shell turns times into local time with
// `date`, so the module needs no time zone of its own. A transcript whose
// "id:mtime" is in $KNOWN has not changed since the last scan: it prints
// "KEEP <id>" and the module reuses the row it holds.
const SCRIPT = `
fmt() { date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M'; }
for f in "$HOME"/.claude/projects/*/*.jsonl; do
  [ -f "$f" ] || continue
  id=$(basename "$f" .jsonl)
  proj=$(basename "$(dirname "$f")")
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
  if [ -n "$iso" ]; then
    e=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "\${iso%%.*}" '+%s' 2>/dev/null || date -d "$iso" '+%s')
    s=$(fmt "$e")
  fi
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$proj" "$m" "$s" "$(fmt "$m")" "\${rest#*\t}"
done
`

// "/…/src/app/.claude/worktrees/fix-x" → "app (worktree fix-x)". Without a cwd only the transcript's folder name is left,
// the path with "/" spelled "-", which no longer tells a "-" in a name apart.
function projectName(cwd: string | undefined, folder: string) {
  if (!cwd) return folder

  const [main = cwd, worktree] = cwd.split('/.claude/worktrees/')
  const name = main.split('/').filter(Boolean).slice(-1)[0] ?? main

  return worktree ? `${name} (worktree ${worktree})` : name
}

function shortPath(path: string | undefined, home: string | undefined) {
  if (!path) return undefined

  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
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

function parse(
  stdout: string,
  known: readonly SessionRow[],
  home: string | undefined,
): SessionRow[] {
  const byId = new Map(known.map(row => [row.id, row]))

  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line): SessionRow[] => {
      const f = line.split('\t')

      if (f[0] === 'KEEP') {
        const kept = byId.get(f[1] ?? '')

        return kept ? [kept] : []
      }

      return [{
        id: f[0] ?? '',
        project: projectName(str(f[14]), f[1] ?? ''),
        path: shortPath(str(f[14]), home),
        updatedAt: Number(f[2] ?? 0),
        scan: SCAN,
        started: f[3] ?? '',
        updated: f[4] ?? '',
        title: f[5] || '(untitled)',
        branch: str(f[6]),
        model: str(f[7]),
        costUsd: num(f[8]),
        linesAdded: num(f[9]),
        linesRemoved: num(f[10]),
        prNumber: num(f[11]),
        prUrl: str(f[12]),
        entrypoint: str(f[13]),
      }]
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// "2026-10-08 21:05" → "10/8"
function shortDate(local: string) {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})/.exec(local) ?? []

  return month && day ? `${Number(month)}/${Number(day)}` : '?'
}

function ago(seconds: number) {
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`

  return `${Math.floor(seconds / 86400)}d ago`
}

// "claude-opus-5-5" → "Opus 5.5"
function modelName(id: string | undefined) {
  if (!id) return undefined
  const [family = '', ...version] = id.replace(/^claude-/, '').split('-')

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim()
}

function section(seconds: number) {
  if (seconds < 86400) return 'Today'
  if (seconds < 7 * 86400) return 'This week'

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
        ? { rows: parse(run.stdout, known, await $.env.get('HOME')), error: null }
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
    const state = await read($, listing)

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

    const now = (await $.clock.now()) / 1000
    const total = state.rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
    const groups = ['Today', 'This week', 'Earlier']
      .map(name => ({
        name,
        rows: state.rows.filter(row => section(now - row.updatedAt) === name),
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
                  <Text size="caption" dimColor>
                    {ago(now - row.updatedAt)}
                  </Text>
                  <Button
                    key={`copy-${row.id}`}
                    label="⧉"
                    plain
                    dimColor
                    onPress={press => copyId($, row.id, press.surface)}
                  />
                </Box>
                <Text size="caption" dimColor wrap="truncate-end">
                  {[row.project, row.branch && row.branch !== 'HEAD' ? row.branch : undefined, modelName(row.model)]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {row.path && (
                  <Text size="caption" dimColor mono wrap="truncate-middle">
                    {row.path}
                  </Text>
                )}
                <Box flexDirection="row" gap={2}>
                  <Text size="caption" dimColor>
                    since {shortDate(row.started)}
                  </Text>
                  {row.costUsd !== undefined && (
                    <Text size="caption" dimColor tabular>
                      ${row.costUsd.toFixed(2)}
                    </Text>
                  )}
                  {(row.linesAdded ?? 0) + (row.linesRemoved ?? 0) > 0 && (
                    <Text size="caption">
                      <Text color="diffAdded">+{row.linesAdded ?? 0}</Text>{' '}
                      <Text color="diffRemoved">−{row.linesRemoved ?? 0}</Text>
                    </Text>
                  )}
                  {row.prUrl && <Link href={row.prUrl} label={`PR #${row.prNumber ?? ''}`} />}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
