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

// Clock at 2026-11-05 12:00Z, 21:00 on the machine's +0900 calendar.
const NOW = Date.UTC(2026, 10, 5, 12) / 1000
const HOUR = 3600
const row = (...fields: (string | number)[]) => fields.join('\t')
const STDOUT = [
  'TZ\t+0900',
  // id, mtime, start, title, branch, model, cost, +, -, PR, PR url, entrypoint, cwd
  row('aaa', NOW - 72 * HOUR, Date.UTC(2026, 9, 1, 3) / 1000, 'Old one', 'main', 'claude-opus-5-5',
    '3.2971', '531', '93', '1', 'https://github.com/o/r/pull/1', 'claude-desktop', '/Users/me/src/older-repo'),
  row('bbb', NOW - 2 * HOUR, NOW - 11 * HOUR, '', 'HEAD', 'claude-sonnet-5-5', '', '', '', '', '', 'cli',
    '/Users/me/app/.claude/worktrees/fix-x'),
  row('ccc', Date.UTC(2025, 11, 1, 5) / 1000, Date.UTC(2025, 11, 1, 2) / 1000, 'Last year', '', '', '', '', '',
    '', '', 'claude-desktop', '/Users/me/yamdes'),
].join('\n')

function engine(on: Parameters<Parameters<typeof test>[1] & Function>[1], stdout: () => string, copied: string[]) {
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: stdout(), stderr: '' } }))
  on('clock.now', () => ({ value: NOW * 1000 }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('/sessions draws two-line cards and copies an id', async ($, on) => {
  const copied: string[] = []
  engine(on as never, () => STDOUT, copied)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'sessions' })
  expect(ran.text).toBe('Sessions pane opened.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // `/sessions` scans in the background; a press settles the work it starts.
    await ui.press({ key: 'refresh' })
    const texts = (await ui.findAll({ type: 'Text' })).map(el => el.text)

    expect(texts).toContain('3 sessions on this machine · $3.30 total')
    expect(texts).toEqual(expect.arrayContaining(['TODAY · 1', 'THIS WEEK · 1', 'EARLIER · 1']))
    // One way to say when, at both ends: hours today, a date before.
    expect(texts).toEqual(expect.arrayContaining(['10:00 → 19:00', '10/1 → 11/2', '2025/12/1']))
    // Line two: the directory and branch, told apart, then the model and cost.
    expect(texts).toEqual(
      expect.arrayContaining([
        '📁 older-repo',
        '⎇ main',
        '+531 −93',
        'Opus 5.5 · $3.30',
        '📁 app (worktree)',
        'Sonnet 5.5',
        '📁 yamdes',
      ]),
    )
    expect(texts.some(text => text.includes('HEAD'))).toBe(false)
    expect(texts.filter(text => /^(Desktop|CLI)$/.test(text))).toEqual(['CLI', 'Desktop', 'Desktop'])
    expect(texts.some(text => /aaa|bbb/.test(text))).toBe(false)
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
  stdout = 'TZ\t+0900\nKEEP\taaa\nKEEP\tbbb\nKEEP\tccc'
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: 'Opus 5.5 · $3.30' })).toBeDefined()
  await ui.unmount()
})
