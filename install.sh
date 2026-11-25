#!/bin/sh
# herdr-bots installer (macOS).
#   ./install.sh           install; refuses to replace a mod or layout that differs from this repo's copy
#   ./install.sh --force   replace them
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
app_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
bots_home=$HOME/.herdr-bots
force=${1:-}
export PATH="$HOME/.local/bin:$HOME/.claude/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; missing=1; }; }
missing=0
need herdr-app "the Herdr desktop app, https://herdr.dev"
need hc "herdr-core; installed with the Herdr app"
need claude "Claude Code CLI"
need /usr/bin/python3 "macOS command line tools"
[ "$missing" = 0 ] || exit 1
command -v alerter >/dev/null 2>&1 || echo "note: alerter not found, so desktop notifications are skipped (in-app toasts still work). https://github.com/vjeantet/alerter"

# Same as the repo's copy? Only the repo's own files count: herdr-app check adds editor typings to a mod folder.
same() {
  src=$1 dst=$2
  [ -f "$src" ] && { cmp -s "$src" "$dst"; return; }
  for f in "$src"/*; do cmp -s "$f" "$dst/$(basename "$f")" || return 1; done
}

# Copy one file or folder into place. An existing copy that differs is kept unless --force.
place() {
  src=$1 dst=$2
  if [ -e "$dst" ] && ! same "$src" "$dst" && [ "$force" != --force ]; then
    echo "skip (exists and differs, use --force): $dst" >&2
    return
  fi
  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo "installed: $dst"
}

mkdir -p "$app_home/mods" "$app_home/layouts" "$bots_home/bin"
for mod in "$repo"/mods/*/; do
  place "${mod%/}" "$app_home/mods/$(basename "$mod")"
done
place "$repo/layouts/bots.json" "$app_home/layouts/bots.json"

cp "$repo/runtime/bin/herdr-bot" "$repo/runtime/bin/botsdb" "$repo/runtime/bin/botsmem" "$bots_home/bin/"
chmod +x "$bots_home/bin/herdr-bot" "$bots_home/bin/botsdb" "$bots_home/bin/botsmem"
[ -e "$bots_home/RULES.md" ] || cp "$repo/runtime/RULES.md" "$bots_home/RULES.md"
"$bots_home/bin/botsdb" migrate >/dev/null
# Install the hooks (SOUL/MEMORY change notes, reflection) for existing bots too; they apply from the next start.
for bot in "$bots_home"/*/; do
  [ -f "$bot/CLAUDE.md" ] && "$bots_home/bin/herdr-bot" hooks "$(basename "$bot")" >/dev/null
done
echo "installed: $bots_home (bin, RULES.md, bots.db, hooks)"

for mod in "$repo"/mods/*/; do
  herdr-app check "$app_home/mods/$(basename "$mod")" 2>&1 | grep -E '^check ' || true
done

cat <<EOF

Next:
  herdr-app do layout.switch '{"name":"bots"}'        # show the Bots sidebar (ctrl-shift-l switches back)
  $bots_home/bin/herdr-bot new mybot                    # make a bot, then edit $bots_home/mybot/SOUL.md
  $bots_home/bin/herdr-bot schedule mybot 10:00 weekdays "Summarize what needs me today."
The first start of a bot asks Claude Code to trust its folder: open its chat window and answer in the terminal.
EOF
