# session-list

A Claude Code mod that lists the Claude Code sessions on this machine in a pane.

Run `/sessions` to open it. Sessions are grouped into Today / This week / Earlier, newest first, and each card shows:

- where it was started (Desktop, CLI, VS Code, SDK) and its title
- the project, git branch and model
- the directory it started in
- when it started, how long ago it was last updated, its cost, lines added/removed and any linked PR

The ⧉ button copies the session ID to the clipboard, and ↻ Refresh scans again. Only transcripts that changed since the last scan are read again.

The mod reads `~/.claude/projects/*/*.jsonl` with `sh`, `grep`, `awk`, `stat` and `date` (macOS and Linux).

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install session-list --marketplace kaakaa/claude-mod-session-list
```

Answer `y` to add the marketplace, then pick a scope (the user scope loads it in every session).

From a shell:

```bash
claude plugin install session-list --marketplace kaakaa/claude-mod-session-list
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `kaakaa/claude-mod-session-list`, then Add plugin.

This repository is private: installing needs read access on GitHub and a git credential for github.com on that machine (an SSH key, or `gh auth login` then `gh auth setup-git`).
