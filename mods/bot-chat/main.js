// Bot chat window: shows the bot's Claude Code transcript (JSONL) like a chat app; input goes to the bot terminal with hc send.
// Permission prompts and multiple-choice questions are not in the transcript, so when the bot needs you a card shows what it asks and hands off to the terminal.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, ScrollHandle, TextView } from "gpui-base";
import { props, agents, terminals, run, theme, exec, hc, home, checking, shared, closeOverlay, openOverlay, watchFolder } from "herdr";

// Print "mtime ctime" of the transcript ($2's session, else the newest) on the first line, then its tail.
// Transcripts can exceed 1 MiB, so use tail instead of readTextFile.
const READ = 'if [ -n "$2" ]; then f="$1/$2.jsonl"; else f=$(ls -t "$1"/*.jsonl 2>/dev/null | head -1); fi; [ -f "$f" ] || exit 0; stat -f "%m %B" "$f"; tail -n 800 "$f"';
const BIN = (h) => `${h}/.herdr-bots/bin/herdr-bot`;
const BOTSDB = (h) => `${h}/.herdr-bots/bin/botsdb`;
// Models and efforts the chat offers; the id goes to claude --model as is.
const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]];
const EFFORTS = ["low", "medium", "high"];
const LAMB = "mods/bots/lamb.png";
const COLUMN = 760;
// UI text follows the system language (the Bots mod puts it in shared("bots.lang")): Korean when Korean comes first, English otherwise.
const tr = (ko, en) => (shared("bots.lang") === "ko" ? ko : en);
const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Claude Code names transcript folders after the cwd with every non-alphanumeric character turned into "-".
const projectDir = (cwd) => `${home()}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
const pad = (n) => String(n).padStart(2, "0");
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const dayLabel = (date) => {
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const name = tr(`${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEK_KO[date.getDay()]}요일`,
    `${WEEK_EN[date.getDay()]}, ${MONTH_EN[date.getMonth()]} ${date.getDate()}`);
  if (same(date, today)) return tr(`오늘 · ${name}`, `Today · ${name}`);
  if (same(date, yesterday)) return tr(`어제 · ${name}`, `Yesterday · ${name}`);
  return name;
};
const elapsed = (ms) => `${Math.floor(ms / 60000)}:${pad(Math.floor((ms % 60000) / 1000))}`;

// One tool call on one line: its command, file, query or URL, whichever it has.
function toolDetail(input = {}) {
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.jql ?? input.url ?? input.description
    ?? Object.values(input).find((v) => typeof v === "string");
  return String(value ?? "").replace(/\s+/g, " ").slice(0, 140);
}

const shortTool = (name) => name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");

function parse(lines) {
  const out = [];
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain || d.isMeta) continue;
    const at = d.timestamp ? new Date(d.timestamp) : null;
    const content = d.message?.content;
    if (d.type === "user" && typeof content === "string") {
      // Messages sent with hc send are recorded wrapped as <hc from="…">text</hc>.
      const wrapped = /^<hc from="([^"]*)">([\s\S]*)<\/hc>$/.exec(content.trim());
      const text = wrapped ? wrapped[2] : content;
      // Internal messages such as <command-name> or <local-command-stdout> are not conversation.
      if (text.trim().startsWith("<")) continue;
      const scheduled = /^\[(스케줄|schedule)\]/.test(text);
      out.push({ id: d.uuid, role: "user", text: scheduled ? text.replace(/^\[(스케줄|schedule)\]\s*/, "") : text, at, source: scheduled ? "schedule" : null });
      continue;
    }
    if (d.type !== "assistant" || !Array.isArray(content)) continue;
    let turn = out[out.length - 1];
    if (!turn || turn.role !== "assistant") { turn = { id: d.uuid, role: "assistant", text: "", tools: [], details: [], at }; out.push(turn); }
    for (const part of content) {
      if (part.type === "text" && part.text.trim()) turn.text += (turn.text ? "\n\n" : "") + part.text;
      if (part.type !== "tool_use") continue;
      turn.tools.push(shortTool(part.name));
      turn.details.push({ name: shortTool(part.name), detail: toolDetail(part.input) });
    }
  }
  return out.filter((m) => m.role === "user" || m.text || m.tools.length);
}

export default class BotChat extends View {
  init(_props, cx) {
    const bot = props()?.bot ?? "";
    this.bot = /^[a-z0-9][a-z0-9-]{0,23}$/.test(bot) ? bot : "";
    this.term = `bot-${this.bot}`;
    this.dir = projectDir(`${home()}/.herdr-bots/${this.bot}`);
    this.messages = [];
    // My messages that were sent but are not in the transcript yet; dropped once they appear.
    this.pending = [];
    this.view = null;          // the past session being viewed; null means the current conversation (newest transcript)
    this.clearedAt = 0;        // when New chat was pressed; the view stays empty until a newer transcript appears
    this.sessions = [];
    this.showSessions = false;
    this.doing = "";
    this.showModel = false;
    this.config = null;          // model and effort stored in the database
    this.pendingRestart = false; // restart after the current turn to apply a model change
    this.copied = null;
    this.scrollTo = null;
    this.tick = 0;
    this.fastUntil = 0;
    this.mtime = "";
    this.error = "";
    this.asking = "";
    this.model = "";
    this.openTools = new Set();
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: tr(`${this.bot} 에게 메시지 보내기 (Shift+Enter 줄바꿈)`, `Message ${this.bot} (Shift+Enter for a new line)`) });
    this.input.set_auto_grow(2, 8);
    this.input.on("submit", (e, cx) => { if (!e.shift) this.send(cx); });
    if (checking()) return;
    cx.spawn(async (cx) => { await this.load(); this.scrollTo = "end"; await this.facts(); cx.notify(); });
    // Read as soon as the transcript folder changes. Before the first chat (no folder yet) or if watching stops, the 2 s check below covers it.
    cx.spawn(async (cx) => {
      for (;;) {
        const changed = await watchFolder(this.dir).catch(() => null);
        if (changed === null) return;
        await this.refresh(cx, false);
      }
    });
    // Fallback check, and refresh of the elapsed time and status line while working.
    cx.timer.every(2000, (cx) => cx.spawn(async (cx) => {
      const status = this.status();
      // Transcript changes already refresh; poll only while the bot works or every 30 s.
      if (status === "working" || status === "blocked" || Date.now() - (this.loadedAt ?? 0) > 30_000) await this.refresh(cx, true);
      if (this.pendingRestart && this.status() !== "working") await this.applyModel(cx);
    }));
    cx.spawn(async (cx) => { await this.loadConfig(); cx.notify(); });
  }

  async refresh(cx, withFacts) {
    if (this.loading) { this.reloadAgain = true; return; }
    this.loading = true;
    try {
      do {
        this.reloadAgain = false;
        const changed = await this.load();
        const status = this.status();
        const active = status === "working" || status === "blocked";
        if (active && withFacts) await this.facts();
        // Only rebuild message objects that changed, so nothing flickers.
        if (changed || (active && withFacts)) cx.notify();
      } while (this.reloadAgain);
    } finally {
      this.loading = false;
    }
  }

  async load() {
    this.loadedAt = Date.now();
    // The current conversation (no view) is the newest 1:1 session, room sessions excluded.
    if (!this.view && (!this.chatSessionAt || Date.now() - this.chatSessionAt > 5000)) {
      const found = await exec(BOTSDB(home()), ["chat-session", this.bot]);
      this.chatSession = found.code === 0 ? JSON.parse(found.stdout).id : null;
      this.chatSessionAt = Date.now();
    }
    const r = await exec("/bin/sh", ["-c", READ, "_", this.dir, this.view ?? this.chatSession ?? ""]);
    const [stamp, ...lines] = r.stdout.split("\n");
    const born = Number(stamp?.split(" ")[1] ?? 0) * 1000;
    // After New chat, stay empty until a newer transcript shows up.
    const waitingNew = this.clearedAt && born < this.clearedAt - 2000;
    const key = waitingNew ? "new" : `${this.view}:${stamp}`;
    if (!stamp || key === this.mtime) return false;
    this.mtime = key;
    if (!waitingNew) this.clearedAt = 0;
    const parsed = waitingNew ? [] : parse(lines);
    // Reuse unchanged message objects so their Markdown is not redrawn.
    const before = new Map(this.messages.map((m) => [m.id, m]));
    const same = (a, b) => a && a.text === b.text && (a.tools?.length ?? 0) === (b.tools?.length ?? 0);
    const added = parsed.filter((m) => !before.has(m.id));
    this.messages = parsed.map((m) => (same(before.get(m.id), m) ? before.get(m.id) : m));
    this.pending = this.pending.filter((p) => !parsed.some((m) => m.role === "user" && m.text.trim() === p.text && m.at && m.at.getTime() >= p.at.getTime() - 10_000));
    // A new bot reply scrolls to its start; only my new message scrolls to the end.
    const reply = added.find((m) => m.role === "assistant");
    if (reply) this.scrollTo = reply.id;
    else if (added.length) this.scrollTo = "end";
    return true;
  }

  // From the terminal info: what the bot asks when it needs you (the msg it reports) and its model.
  async facts() {
    const r = await hc(["get", this.term, "--json"]);
    if (r.code !== 0) return;
    const facts = JSON.parse(r.stdout);
    this.asking = facts.status?.state === "blocked" ? facts.status?.msg ?? "" : "";
    this.doing = facts.status?.state === "working" ? facts.status?.msg ?? "" : "";
    const argv = facts.foreground?.argv ?? facts.argv ?? [];
    const at = argv.indexOf("--model");
    this.model = at >= 0 ? argv[at + 1].replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase()) : this.model;
  }

  async loadConfig() {
    const r = await exec(BOTSDB(home()), ["bot-config", this.bot]);
    if (r.code === 0) this.config = JSON.parse(r.stdout);
  }

  // Choosing a model or effort saves it to the database and restarts the bot (continuing the last conversation); while working, after the turn.
  async chooseModel(model, effort, cx) {
    await exec(BOTSDB(home()), ["set-model", this.bot, model, effort]);
    this.config = { model, effort };
    this.pendingRestart = true;
    cx.notify();
    if (this.status() !== "working") await this.applyModel(cx);
  }

  async applyModel(cx) {
    this.pendingRestart = false;
    this.restarting = true;
    cx.notify();
    await exec(BIN(home()), ["restart", this.bot], { timeout: 120_000 }).catch(() => {});
    this.restarting = false;
    this.mtime = "";
    await this.facts();
    await this.refresh(cx, true);
    cx.notify();
  }

  modelPanel(t, keep) {
    const current = this.config ?? {};
    const option = (id, label, on, onClick) => div().id(id).px(10).py(3).rounded(999).text_size(12).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
    const note = this.restarting ? tr("다시 띄우는 중…", "Restarting…") : this.pendingRestart ? tr("작업이 끝나면 다시 띄워 적용합니다", "Applies after this turn") : tr("고르면 봇을 다시 띄워 적용합니다(대화는 이어집니다)", "Picking restarts the bot (the conversation continues)");
    return v_flex().flex_none().px(22).py(10).gap(8).border_b_1().border_color(t.border).on_mouse_down("left", keep)
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(div().w(52).text_size(12).text_color(t.dim).child(tr("모델", "Model")))
        .children(MODELS.map(([id, label]) => option(`model-${id}`, label, current.model === id, (_e, cx) => cx.spawn(async (cx) => { await this.chooseModel(id, current.effort ?? "low", cx); })))))
      .child(h_flex().gap(6).items_center()
        .child(div().w(52).text_size(12).text_color(t.dim).child("effort"))
        .children(EFFORTS.map((e) => option(`effort-${e}`, e, current.effort === e, (_e, cx) => cx.spawn(async (cx) => { await this.chooseModel(current.model ?? "claude-sonnet-5-5", e, cx); })))))
      .child(div().text_size(11.5).text_color(this.pendingRestart || this.restarting ? t.working : t.dim).child(note));
  }

  // The display name set in the Bots section; the folder name when there is none.
  title() {
    return shared("bots.titles")?.[this.bot] || this.bot;
  }

  terminal() {
    return terminals().find((x) => x.labels?.["herdr.bot"] === this.bot && !x.labels?.["herdr.room"] && x.state === "live") ?? null;
  }

  status() {
    const terminal = this.terminal();
    return terminal ? agents().find((a) => a.address === terminal.address)?.status ?? "idle" : null;
  }

  // Show a sent message as a bubble at once and scroll to it. hc send waits until input is quiet (about 3 s), so it runs in the background.
  send(cx) {
    const text = this.input.value().trim();
    if (!text) return;
    const message = { id: `pending-${Date.now()}`, role: "user", text, at: new Date(), pending: true };
    this.pending.push(message);
    this.input.set_value("");
    this.error = "";
    this.scrollTo = message.id;
    this.fastUntil = Date.now() + 60_000;
    cx.notify();
    cx.spawn(async (cx) => {
      if (!this.terminal()) {
        message.note = tr("봇을 띄우는 중", "starting the bot");
        cx.notify();
        await exec(BIN(home()), ["start", this.bot], { timeout: 120_000 }).catch(() => {});
        message.note = "";
      }
      const sent = await hc(["send", this.term, text]);
      if (sent.code === 0) return;
      message.failed = sent.stderr.trim() || tr("보내지 못했습니다. 터미널에서 확인하세요.", "Could not send. Check the terminal.");
      cx.notify();
    });
  }

  // Minimize: reopen the window with the same key at header height (the key keeps its position); restore to full size.
  resize(minimized) {
    openOverlay({ kind: "window", mod: "bot-chat", key: `chat-${this.bot}`, keep: true, width: minimized ? 320 : 520, height: minimized ? 52 : 680, props: { bot: this.bot, minimized } });
  }

  // The session list comes from the local database index (botsdb sessions); botsdb rescans only transcripts that changed.
  async loadSessions() {
    const r = await exec(`${home()}/.herdr-bots/bin/botsdb`, ["sessions", this.bot]);
    const list = r.code === 0 ? JSON.parse(r.stdout) : [];
    this.sessions = list.map((x) => ({ ...x, at: new Date(x.at * 1000) }));
  }

  openSession(session, cx) {
    this.view = session.current ? null : session.id;
    this.showSessions = false;
    this.mtime = "";
    this.messages = [];
    this.scrollTo = "end";
    cx.spawn(async (cx) => { await this.load(); this.scrollTo = "end"; cx.notify(); });
    cx.notify();
  }

  // New chat: send /clear to the bot to start a fresh session.
  newChat(cx) {
    this.view = null;
    this.showSessions = false;
    this.chatSessionAt = 0;
    this.clearedAt = Date.now();
    this.messages = [];
    this.pending = [];
    this.mtime = "";
    this.fastUntil = Date.now() + 60_000;
    cx.spawn(async () => { await hc(["send", this.term, "/clear"]); });
    cx.notify();
  }

  // Continue the past conversation being viewed: restart the bot on that session.
  resumeViewed(cx) {
    const id = this.view;
    this.resuming = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await exec(BIN(home()), ["resume", this.bot, id], { timeout: 120_000 }).catch(() => {});
      this.resuming = false;
      this.view = null;
      this.mtime = "";
      await this.load();
      this.scrollTo = "end";
      cx.notify();
    });
  }

  stop() {
    hc(["interrupt", this.term]).catch(() => {});
  }

  // Display order with date dividers between messages.
  rows() {
    const rows = [];
    let day = "";
    for (const m of [...this.messages, ...this.pending]) {
      const label = m.at ? dayLabel(m.at) : "";
      if (label && label !== day) { rows.push({ divider: label }); day = label; }
      rows.push(m);
    }
    return rows;
  }

  userRow(m, t) {
    const meta = m.failed ?? [m.at ? clock(m.at) : "", m.source === "schedule" ? tr("일정 실행", "scheduled") : m.source, m.note || (m.pending ? tr("보내는 중", "sending") : "")].filter(Boolean).join(" · ");
    return v_flex().w_full().items_end().gap(4)
      .child(div().max_w("80%").px(14).py(10).rounded(18).bg(t.selected).text_color(t.foreground).when(m.pending, (el) => el.opacity(0.7))
        .child(TextView.markdown(`m-${m.id}`, m.text)))
      .when(Boolean(meta), (el) => el.child(div().text_size(11).text_color(m.failed ? t.blocked : t.dim).child(meta)));
  }

  botRow(m, t) {
    const open = this.openTools.has(m.id);
    const names = [...new Set(m.tools)];
    const toolChip = h_flex().id(`tools-${m.id}`).gap(6).px(10).py(4).rounded(8).border_1().border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { open ? this.openTools.delete(m.id) : this.openTools.add(m.id); cx.notify(); })
      .child(svg(`mods/workspace-chrome/${open ? "chevron-down" : "chevron-right"}.svg`).size(12))
      .child(tr(`도구 ${m.tools.length}회`, `${m.tools.length} tool calls`) + ` · ${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""}`);
    return h_flex().w_full().items_start().gap(12)
      .child(image(LAMB).size(28).rounded(7).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(this.title()))
          .when(Boolean(m.at), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(clock(m.at))))
          .child(div().flex_1())
          .when(Boolean(m.text), (el) => el.child(div().id(`copy-${m.id}`).px(6).py(1).rounded(4).text_size(11.5).cursor_pointer()
            .text_color(this.copied === m.id ? t.done : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.write_to_clipboard(m.text); this.copied = m.id; cx.notify(); cx.timer.after(1500, (cx) => { this.copied = null; cx.notify(); }); })
            .child(this.copied === m.id ? tr("복사됨", "Copied") : tr("복사", "Copy")))))
        .when(m.tools.length > 0, (el) => el.child(h_flex().child(toolChip)))
        .when(open, (el) => el.child(v_flex().gap(3).pl(4).children((m.details ?? []).map((d, i) =>
          h_flex().id(`tool-${m.id}-${i}`).gap(8).text_size(12)
            .child(div().flex_none().text_color(t.muted).child(d.name))
            .child(div().min_w(0).truncate().text_color(t.dim).child(d.detail))))))
        .when(Boolean(m.text), (el) => el.child(div().text_color(t.foreground).child(TextView.markdown(`m-${m.id}`, m.text)))));
  }

  statusRows(status, t) {
    const terminal = this.terminal();
    const toTerminal = () => terminal && run("terminal.peek", { terminal: terminal.address });
    if (status === "blocked") {
      return [h_flex().w_full().px(14).py(12).gap(12).items_center().rounded(12)
        .bg(t.blocked + "10").border_1().border_color(t.blocked + "40")
        .child(image(LAMB).size(22).rounded(6).flex_none())
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child(tr("확인이 필요해요", "Needs you")))
          .child(div().truncate().text_size(12.5).text_color(t.muted).child(this.asking || tr("봇이 권한 확인이나 선택을 기다립니다", "The bot is waiting for a permission or a choice"))))
        .child(div().id("answer-in-terminal").flex_none().px(12).py(6).rounded(8).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12.5).cursor_pointer().on_click(toTerminal).child(tr("터미널에서 답하기", "Answer in terminal")))];
    }
    if (status !== "working") return [];
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user" && m.at);
    const workers = terminal ? terminals().filter((x) => x.parent === terminal.address && x.state === "live").length : 0;
    const parts = [tr("작업 중", "Working"), lastUser ? elapsed(Date.now() - lastUser.at.getTime()) : "", this.doing, workers ? tr(`워커 ${workers}개 실행 중`, `${workers} workers running`) : ""];
    return [h_flex().gap(10).items_center().text_size(12.5).text_color(t.muted)
      .child(h_flex().flex_none().gap(3).children([1, 0.6, 0.3].map((o) => div().size(6).rounded(3).bg(t.working).opacity(o))))
      .child(div().min_w(0).truncate().child(parts.filter(Boolean).join(" · ")))];
  }

  sessionList(t, keep) {
    const row = (session) => v_flex().id(`session-${session.id}`).px(12).py(8).gap(2).rounded(8).cursor_pointer()
      .when((this.view ?? this.sessions[0]?.id) === session.id, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openSession(session, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.foreground).child(session.title))
        .when(session.current, (el) => el.child(div().flex_none().px(6).rounded(4).text_size(11).text_color(t.done).child(tr("지금 대화", "current"))))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(session.at.toDateString() === new Date().toDateString() ? clock(session.at) : `${session.at.getMonth() + 1}/${session.at.getDate()}`)));
    return v_flex().id("session-list").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(10).gap(2).on_mouse_down("left", keep)
      .child(h_flex().id("new-chat").px(12).py(8).mb(6).gap(8).items_center().rounded(8).cursor_pointer().bg(t.solid).text_color(t.solid_foreground)
        .on_click((_e, cx) => this.newChat(cx)).child(tr("+ 새 대화", "+ New chat")))
      .when(this.sessions.length === 0, (el) => el.child(div().px(12).py(8).text_color(t.dim).child(tr("대화가 없습니다", "No chats"))))
      .children(this.sessions.map(row));
  }

  pastBanner(t, keep) {
    const title = this.sessions.find((x) => x.id === this.view)?.title ?? tr("지난 대화", "Past chat");
    const button = (id, label, filled, onClick) => div().id(id).flex_none().px(12).py(6).rounded(8).text_size(12.5).cursor_pointer()
      .when(filled, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!filled, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick).child(label);
    return h_flex().flex_none().w_full().justify_center().px(20).pb(18).pt(6).on_mouse_down("left", keep)
      .child(h_flex().w_full().max_w(COLUMN).px(14).py(12).gap(10).items_center().rounded(12).border_1().border_color(t.border).bg(t.surface)
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(12).text_color(t.dim).child(tr("지난 대화를 보고 있습니다", "Viewing a past chat")))
          .child(div().truncate().text_size(13).text_color(t.foreground).child(title)))
        .child(button("back-current", tr("지금 대화로", "Back to current"), false, (_e, cx) => this.openSession({ current: true }, cx)))
        .child(button("resume", this.resuming ? tr("여는 중…", "Opening…") : tr("이 대화 이어가기", "Continue this chat"), true, (_e, cx) => { if (!this.resuming) this.resumeViewed(cx); })));
  }

  render(cx) {
    const t = theme();
    const status = this.status();
    const terminal = this.terminal();
    const working = status === "working";
    const chip = (text) => div().px(10).py(2).rounded(999).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(text);
    // In a floating window a press anywhere moves the window. Keep the header as the handle and stop presses here.
    const keep = (_e, cx) => cx.stop_propagation();
    const minimized = Boolean(props()?.minimized);
    const windowButton = (id, label, onClick) => div().id(id).size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", keep).on_click(onClick).child(label);
    // scroll_to_item only reaches direct children of the scroll element, so each row gets its own centered wrapper.
    const line = (child, top = 11, bottom = 11) => h_flex().w_full().flex_none().justify_center().pt(top).pb(bottom)
      .child(v_flex().w_full().max_w(COLUMN).px(20).child(child));
    const ordered = this.rows();
    const items = ordered.map((r) => line(r.divider
      ? h_flex().w_full().justify_center().child(div().text_size(11.5).text_color(t.dim).child(r.divider))
      : r.role === "user" ? this.userRow(r, t) : this.botRow(r, t)));
    const status_ = this.statusRows(status, t).map((row) => line(row));
    if (this.messages.length === 0 && this.pending.length === 0) items.push(line(div().text_color(t.dim).child(terminal ? tr("아직 대화가 없습니다. 아래에서 말을 걸어 보세요.", "No messages yet. Say something below.") : tr("봇이 꺼져 있습니다. 사이드바 Bots 에서 눌러 띄우세요.", "The bot is off. Click it in the Bots sidebar to start it."))));
    const children = [line(div(), 15, 0), ...items, ...status_, line(div(), 0, 15)];
    if (this.scrollTo) {
      const at = this.scrollTo === "end" ? children.length - 1 : ordered.findIndex((r) => r.id === this.scrollTo) + 1;
      if (at > 0) this.scroll.scroll_to_item(at);
      this.scrollTo = null;
    }
    const round = (id, icon, onClick, filled) => div().id(id).size(32).rounded(16).flex_none().flex().items_center().justify_center()
      .cursor_pointer().on_click(onClick)
      .when(filled, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!filled, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .child(icon);
    return v_flex().size_full().min_h(0).bg(t.background).text_size(14)
      .child(h_flex().h(52).cursor_grab().flex_none().px(minimized ? 14 : 22).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().relative().size(24).flex_none()
          .child(image(LAMB).size(24).rounded(6))
          .child(div().absolute().right(-2).bottom(-2).size(9).rounded(5).border_2().border_color(t.background).bg(status ? t[status] : t.dim)))
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(this.title()))
        .when(!minimized, (el) => el.child(div().id("model-chip").cursor_pointer().on_mouse_down("left", keep)
          .on_click((_e, cx) => { this.showModel = !this.showModel; cx.notify(); })
          .child(chip(`${this.model || tr("모델", "Model")} ▾`))))
        .child(div().flex_1())
        .when(!minimized, (el) => el.child(div().id("sessions").cursor_pointer().on_mouse_down("left", keep)
          .on_click((_e, cx) => {
            this.showSessions = !this.showSessions;
            if (this.showSessions) cx.spawn(async (cx) => { await this.loadSessions(); cx.notify(); });
            cx.notify();
          })
          .child(chip(this.showSessions ? tr("대화 닫기", "Close chats") : tr("대화", "Chats")))))
        .when(Boolean(terminal) && !minimized, (el) => el.child(div().id("to-terminal").cursor_pointer().on_mouse_down("left", keep)
          .on_click(() => run("terminal.peek", { terminal: terminal.address })).child(chip(tr("터미널 보기", "Terminal")))))
        .when(Boolean(props()?.overlay), (el) => el
          .child(windowButton("minimize", minimized ? "□" : "–", () => this.resize(!minimized)))
          .child(windowButton("close", "✕", () => closeOverlay(props().overlay)))))
      .when(!minimized && this.showModel, (body) => body.child(this.modelPanel(t, keep)))
      .when(!minimized && this.showSessions, (body) => body.child(this.sessionList(t, keep)))
      .when(!minimized && !this.showSessions, (body) => body.child(v_flex().id("chat").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).on_mouse_down("left", keep)
        .children(children)))
      .when(!minimized && !this.showSessions && Boolean(this.view), (body) => body.child(this.pastBanner(t, keep)))
      .when(!minimized && !this.showSessions && !this.view, (body) => body.child(h_flex().flex_none().w_full().justify_center().px(20).pb(18).pt(6).on_mouse_down("left", keep)
        .child(v_flex().w_full().max_w(COLUMN).gap(6)
          .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)))
          .child(v_flex().w_full().px(14).pt(10).pb(10).gap(8).rounded(16).border_1().border_color(t.border).bg(t.surface)
            .child(Textarea.new(this.input))
            .child(h_flex().items_center().gap(8)
              .child(div().text_size(12).text_color(t.dim).child(working ? tr("작업 중에도 보내면 이 턴이 끝난 뒤 이어서 처리합니다", "Messages sent now run after this turn") : tr("Enter 보내기", "Enter to send")))
              .child(div().flex_1())
              .when(working, (el) => el.child(round("stop", div().size(10).rounded(2).bg(t.foreground), () => this.stop(), false)))
              .child(round("send", "↑", (_e, cx) => this.send(cx), true)))))));
  }
}
