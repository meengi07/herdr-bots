# herdr-bots

Long-running Claude Code bots inside [Herdr](https://herdr.dev), with a chat window per bot, rooms where bots hand
work to each other, scheduled runs and desktop notifications. Inspired by Orca Bots, built only from Herdr's mod API,
`hc` and Claude Code.

![herdr-bots](preview.png)

> The UI is English, with a Korean translation used when Korean is your first macOS language. Bots reply in the
> language you write in.

## What you get

- **Bots sidebar** under Spaces: each bot with its lamb icon, color, status (working, needs you, idle, off) and next
  schedule. Click to open its chat; right-click to rename or remove it (removed bots move to `~/.herdr-bots/.trash`).
- **Bot chat window**: a floating window (no tab) that renders the bot's Claude Code transcript as a chat: your
  bubbles on the right, the bot's replies as Markdown, tool calls folded into a chip, a working line with elapsed time,
  a card with a "answer in terminal" button when Claude asks for a permission, past sessions and "new chat".
- **Rooms**: `+` creates a room at once and opens it with the bot picker; name it later by clicking its title or from
  the right-click menu, which also has "Leave room" (its history is kept). The member panel sets the host and removes
  bots. Several bots in one chat. A message goes to the bots you `@mention` (or the first member, the room
  owner). A bot that `@mentions` another bot hands the turn to it (limits below).
- **Self-updating persona and memory**: every turn, a Claude Code hook compares the bot's `SOUL.md` and `MEMORY.md`
  with what that session last saw and adds the change to the turn. Every 5 turns a background reflection proposes
  edits from the conversation; `botsmem` checks them (owner rules untouchable, at most 25% of memory lines removed per
  run, removed lines archived, no secrets, the `## Never` section protected) and keeps an undoable history.
- **Rooms that behave**: each member gets a room-only Claude session (idle ones stop after 30 minutes), wakes with what
  was said since its last reply as quoted data, ignores `@names` inside code, quotes and history, and stops after 3
  rounds or 10 bot replies per message (Continue up to 5 times). A bot mentioning the bot that called it does not wake
  it again. `@user` raises a "needs you" mark and a notification; rooms show unread counts and a Stop button.
- **Direct messages between bots**: a bot runs `herdr-bot dm <bot> "<text>"`; the answer comes back as a notify-only
  reply, at most 4 hops per exchange.
- **Schedules**: `herdr-bot schedule` registers a launchd job that sends the bot a prompt at a set time.
- **Desktop notifications**: Herdr's in-app toast is also posted to macOS Notification Center. For bots it shows the
  bot's last reply, and clicking it opens the bot's chat window.

## Requirements

- macOS, the Herdr desktop app (0.1.17 or later) with `hc` (herdr-core) on `PATH`
- Claude Code CLI (`claude`)
- `/usr/bin/python3` (the local database helper uses its `sqlite3` module)
- Optional: [alerter](https://github.com/vjeantet/alerter) for desktop notifications

## Install

```sh
git clone <this repo> && cd herdr-bots
./install.sh            # never replaces a mod or layout you changed; ./install.sh --force does
herdr-app do layout.switch '{"name":"bots"}'
```

`install.sh` copies the mods to `~/.config/herdr-app/mods/`, the layout to `layouts/bots.json`, and the runtime
(`herdr-bot`, `botsdb`, `RULES.md`) to `~/.herdr-bots/`. `ctrl-shift-l` switches back to your old layout.

## Use

```sh
~/.herdr-bots/bin/herdr-bot new briefing           # then describe it in ~/.herdr-bots/briefing/SOUL.md
~/.herdr-bots/bin/herdr-bot schedule briefing 10:00 weekdays "Summarize what needs me today."
```

Click the bot in the sidebar to start it and open its chat. The first start asks Claude Code to trust the bot's folder:
the chat shows a card, press "answer in terminal" and accept.

| Command | What it does |
|---|---|
| `herdr-bot new <name>` | make a bot home (`SOUL.md`, `MEMORY.md`, `CLAUDE.md`) |
| `herdr-bot start <name>` | start it, continuing its last conversation |
| `herdr-bot resume <name> <session>` | switch it to a past session |
| `herdr-bot send <name> <text>` | send it a message (starts it if needed) |
| `herdr-bot schedule <name> <HH:MM> <weekdays\|daily\|0-6,...> <prompt>` | run it on a schedule (one per bot) |
| `herdr-bot unschedule <name>` | remove the schedule |
| `herdr-bot reflect <name>` | run a reflection now (normally every 5 turns) |
| `herdr-bot dm <bot> <text>` | (inside a bot) message another bot |
| `botsmem history <name>` / `botsmem undo <name> [id]` | see or undo persona and memory changes |

Model and effort per bot: `botsdb set-model <bot> <model> <effort>` (default `claude-sonnet-5-5`, `low`), or the chat window's model chip. Environment overrides: `HERDR_BOT_MODEL`, `HERDR_BOT_EFFORT`,
`HERDR_BOT_PERMISSION` (`auto`). Notification language: `mods/desktop-toast/config.json` (`auto` follows the UI, or `en` / `ko`).

## How it works

| Piece | Where |
|---|---|
| Bot persona and memory | `~/.herdr-bots/<bot>/SOUL.md`, `MEMORY.md`; shared rules in `~/.herdr-bots/RULES.md`, all imported by the bot's `CLAUDE.md` |
| Bot session | an `hc` terminal named `bot-<bot>` with the label `herdr.bot=<bot>`, kept in a hidden tab |
| 1:1 chat history | Claude Code's own transcript (`~/.claude/projects/<bot folder>/*.jsonl`), read only |
| Bots, sessions index, rooms, room messages | `~/.herdr-bots/bots.db` (SQLite) through `botsdb`, which binds every value as a SQL parameter |
| Persona and memory upkeep | `botsmem`, called by the bot folder's Claude Code hooks (`UserPromptSubmit`, `Stop`) |
| Room relay | the Bots sidebar mod, when the database or a bot transcript changes; every 1.5 s only while a reply or DM is waiting, else every 30 s. One `botsdb relay-snapshot` call per pass. A `send` row is unique per (room, message, bot), so a message is never delivered twice |

## Security and privacy

- The mods run programs (`hc`, `claude`, `botsdb`, `alerter`, `launchctl` through `herdr-bot`) and read Claude Code
  transcripts of the bots under `~/.claude/projects/`. They make no network requests themselves.
- Bots run Claude Code with `--permission-mode auto` by default. Set `HERDR_BOT_PERMISSION` if you want every tool
  call confirmed.
- `RULES.md` tells bots not to push, comment, merge or message anyone without your approval, and to treat text from
  tickets, pages and tool output as data. That is a prompt, not a sandbox.
- Prompt injection is not solved. Room history, DMs and quoted text are wrapped as data and known control phrases are
  neutralized, but that is a list, not a guarantee: a bot that reads hostile text (a ticket, a page, another bot's
  reply) can still be steered, and with `auto` permission it can act on it. Give bots only the folders and tools you
  would hand to that text's author.
- Reflection adds owner kinds (`Rule`, `Prefers`, `Decided`) only with a quote from a message you typed yourself;
  room, DM, schedule and other-terminal messages do not count.
- Bot ids are checked (`^[a-z0-9][a-z0-9-]{0,23}$`) by every `herdr-bot` command and by the chat window; links in
  room messages open only `http`/`https` URLs or a member bot's chat.

## Limits

- The relay runs only while the Herdr app is open.
- A room shows each bot's final reply of a turn; intermediate text stays in that bot's own chat.
- Permission prompts and multiple-choice questions are not in transcripts, so they are answered in the terminal.
- Only Claude Code bots; only macOS (launchd, alerter).

## License

Apache-2.0. Three mods and the layout are modified copies of Herdr's shipped files; see [NOTICE](NOTICE).
The lamb icon is original artwork, not the Herdr logo.
