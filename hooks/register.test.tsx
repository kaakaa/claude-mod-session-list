import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-list',
  component: 'Pane',
  requestId: 'session-list',
  props: {
    title: 'Claude sessions',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Clock at 2026-11-05 12:00:00Z; "bbb" was written two hours before.
const NOW = Date.UTC(2026, 10, 5, 12)
const row = (...fields: (string | number)[]) => fields.join('\t')
const STDOUT = [
  row('aaa', '-Users-me-src-older-repo', NOW / 1000 - 3 * 86400, '2026-10-01 10:00', '2026-11-02 12:00',
    'Old one', 'main', 'claude-opus-5-5', '3.2971', '531', '93', '1', 'https://github.com/o/r/pull/1',
    'claude-desktop', '/Users/me/src/older-repo'),
  row('bbb', '-Users-me-app--claude-worktrees-fix-x', NOW / 1000 - 7200, '2026-11-01 09:00', '2026-11-05 10:00',
    '', 'HEAD', 'claude-sonnet-5-5', '', '', '', '', '', 'cli', '/Users/me/app/.claude/worktrees/fix-x'),
].join('\n')

function engine(on: Parameters<Parameters<typeof test>[1] & Function>[1], stdout: () => string, copied: string[]) {
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: stdout(), stderr: '' } }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('/sessions draws grouped cards and copies an id', async ($, on) => {
  const copied: string[] = []
  engine(on as never, () => STDOUT, copied)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'sessions' })
  expect(ran.text).toBe('Sessions pane opened.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // `/sessions` scans in the background; a press settles the work it starts.
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Text', text: /sessions on this machine/ }))?.text).toBe(
      '2 sessions on this machine · $3.30 total',
    )
    expect(await ui.find({ type: 'Text', text: /^TODAY/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^THIS WEEK/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^app/ }))?.text).toBe(
      'app (worktree fix-x) · Sonnet 5.5',
    )
    expect((await ui.find({ type: 'Text', text: /^older-repo ·/ }))?.text).toBe(
      'older-repo · main · Opus 5.5',
    )
    expect((await ui.find({ type: 'Text', text: /^\$3\.30/ }))?.text).toBe('$3.30')
    expect(await ui.find({ type: 'Text', text: '~/src/older-repo' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~/app/.claude/worktrees/fix-x' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^(Desktop|CLI)$/ })).map(el => el.text)).toEqual([
      'CLI',
      'Desktop',
    ])
    expect(await ui.find({ type: 'Text', text: /aaa|bbb/ })).toBeUndefined()
    await ui.press({ key: 'copy-bbb' })
    await ui.unmount()
  }

  expect(copied).toEqual(['bbb', 'bbb'])
})

test('an unchanged transcript keeps the row it had', async ($, on) => {
  let stdout = STDOUT
  engine(on as never, () => stdout, [])

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'sessions' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  stdout = 'KEEP\taaa\nKEEP\tbbb'
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^older-repo ·/ }))?.text).toBe('older-repo · main · Opus 5.5')
  await ui.unmount()
})
