// 봇 채팅 화면: Claude Code 대화 기록(JSONL)을 채팅 앱처럼 보여 주고, 입력은 hc send 로 봇 터미널에 보낸다.
// 권한 확인 · 선택지 질문은 기록에 남지 않으므로, 응답 필요 상태면 무엇을 묻는지와 함께 터미널로 넘기는 카드를 띄운다.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, ScrollHandle, TextView } from "gpui-base";
import { props, agents, terminals, run, theme, exec, hc, home, checking, shared, closeOverlay, openOverlay, watchFolder } from "herdr";

// 기록 파일($2 세션, 없으면 가장 최근)의 「수정 시각 생성 시각」을 첫 줄에, 그 뒤에 끝부분을 낸다.
// 기록은 1 MiB 를 넘을 수 있어 readTextFile 대신 tail 을 쓴다.
const READ = 'if [ -n "$2" ]; then f="$1/$2.jsonl"; else f=$(ls -t "$1"/*.jsonl 2>/dev/null | head -1); fi; [ -f "$f" ] || exit 0; stat -f "%m %B" "$f"; tail -n 800 "$f"';
const BIN = (h) => `${h}/.herdr-bots/bin/herdr-bot`;
const BOTSDB = (h) => `${h}/.herdr-bots/bin/botsdb`;
// 채팅에서 고를 수 있는 모델 · effort. id 는 claude --model 에 그대로 들어간다.
const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]];
const EFFORTS = ["low", "medium", "high"];
const LAMB = "mods/bots/lamb.png";
const COLUMN = 760;
// 화면 문구는 시스템 언어로(Bots mod 가 shared("bots.lang") 에 둔다): 한국어면 한국어, 그 밖은 영어.
const tr = (ko, en) => (shared("bots.lang") === "ko" ? ko : en);
const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Claude Code 가 cwd 로 기록 폴더 이름을 짓는 규칙: 영숫자 말고는 모두 "-".
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

// 도구 호출 한 건을 한 줄로: 명령 · 파일 · 검색어 · 주소 중 있는 것.
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
      // hc send 로 들어온 메시지는 <hc from="…">본문</hc> 로 감싸여 기록된다.
      const wrapped = /^<hc from="([^"]*)">([\s\S]*)<\/hc>$/.exec(content.trim());
      const text = wrapped ? wrapped[2] : content;
      // <command-name> · <local-command-stdout> 같은 내부 메시지는 대화가 아니다.
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
    // 보냈지만 아직 대화 기록에 안 들어온 내 메시지. 기록에 나타나면 뺀다.
    this.pending = [];
    this.view = null;          // 보고 있는 지난 세션 id. null 이면 지금 대화(가장 최근 기록)
    this.clearedAt = 0;        // 「새 대화」를 누른 시각. 그 뒤에 생긴 기록이 나타날 때까지 빈 화면
    this.sessions = [];
    this.showSessions = false;
    this.doing = "";
    this.showModel = false;
    this.config = null;          // DB 에 저장된 모델 · effort
    this.pendingRestart = false; // 작업 중이라 끝난 뒤 다시 띄워 적용할 것
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
    // 대화 기록 폴더가 바뀌는 즉시 읽는다. 폴더가 아직 없거나(첫 대화 전) 감시가 끊기면 아래 2초 확인이 대신한다.
    cx.spawn(async (cx) => {
      for (;;) {
        const changed = await watchFolder(this.dir).catch(() => null);
        if (changed === null) return;
        await this.refresh(cx, false);
      }
    });
    // 예비 확인 겸 작업 중 경과 시간 · 상태 문구 갱신.
    cx.timer.every(2000, (cx) => cx.spawn(async (cx) => {
      await this.refresh(cx, true);
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
        // 메시지 객체는 바뀐 것만 새로 만들어 깜빡이지 않는다.
        if (changed || (active && withFacts)) cx.notify();
      } while (this.reloadAgain);
    } finally {
      this.loading = false;
    }
  }

  async load() {
    // 지금 대화(view 없음)는 방 전용 세션을 뺀 최신 1:1 세션이다.
    if (!this.view && (!this.chatSessionAt || Date.now() - this.chatSessionAt > 5000)) {
      const found = await exec(BOTSDB(home()), ["chat-session", this.bot]);
      this.chatSession = found.code === 0 ? JSON.parse(found.stdout).id : null;
      this.chatSessionAt = Date.now();
    }
    const r = await exec("/bin/sh", ["-c", READ, "_", this.dir, this.view ?? this.chatSession ?? ""]);
    const [stamp, ...lines] = r.stdout.split("\n");
    const born = Number(stamp?.split(" ")[1] ?? 0) * 1000;
    // 새 대화를 누른 뒤에는 그보다 늦게 생긴 기록이 보일 때까지 비워 둔다.
    const waitingNew = this.clearedAt && born < this.clearedAt - 2000;
    const key = waitingNew ? "new" : `${this.view}:${stamp}`;
    if (!stamp || key === this.mtime) return false;
    this.mtime = key;
    if (!waitingNew) this.clearedAt = 0;
    const parsed = waitingNew ? [] : parse(lines);
    // 바뀌지 않은 메시지는 같은 객체를 그대로 써서 마크다운을 다시 그리지 않는다.
    const before = new Map(this.messages.map((m) => [m.id, m]));
    const same = (a, b) => a && a.text === b.text && (a.tools?.length ?? 0) === (b.tools?.length ?? 0);
    const added = parsed.filter((m) => !before.has(m.id));
    this.messages = parsed.map((m) => (same(before.get(m.id), m) ? before.get(m.id) : m));
    this.pending = this.pending.filter((p) => !parsed.some((m) => m.role === "user" && m.text.trim() === p.text && m.at && m.at.getTime() >= p.at.getTime() - 10_000));
    // 새 봇 답이 오면 그 답의 시작으로, 내 메시지만 새로 들어왔으면 맨 끝으로.
    const reply = added.find((m) => m.role === "assistant");
    if (reply) this.scrollTo = reply.id;
    else if (added.length) this.scrollTo = "end";
    return true;
  }

  // 응답 필요일 때 무엇을 묻는지(봇이 보고한 msg)와 모델을 터미널 정보에서 읽는다.
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

  // 모델 · effort 를 고르면 DB 에 저장하고 봇을 다시 띄운다(마지막 대화 이어서). 작업 중이면 끝난 뒤에.
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

  // Bots 섹션에서 바꾼 표시 이름(bot.json). 없으면 폴더 이름.
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

  // 보낸 메시지는 바로 말풍선으로 띄우고 그 자리로 스크롤한다. hc send 는 입력이 조용해질 때까지(약 3초) 기다리므로 뒤에서 보낸다.
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

  // 최소화: 같은 key 로 창을 헤더 높이로 다시 연다(위치는 key 가 기억한다). 복원은 원래 크기로.
  resize(minimized) {
    openOverlay({ kind: "window", mod: "bot-chat", key: `chat-${this.bot}`, keep: true, width: minimized ? 320 : 520, height: minimized ? 52 : 680, props: { bot: this.bot, minimized } });
  }

  // 대화 목록은 로컬 DB 색인(botsdb sessions)에서 읽는다. 바뀐 세션만 botsdb 가 기록 파일을 다시 훑는다.
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

  // 새 대화: 봇에게 /clear 를 보내 세션을 새로 시작한다.
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

  // 보고 있는 지난 대화를 이어 간다: 봇을 그 세션으로 다시 띄운다.
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

  // 메시지 사이에 날짜 구분선을 끼운 표시 순서.
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
    // 떠 있는 창에서는 누르고 끄는 곳이 창을 옮긴다. 헤더만 손잡이로 두고 나머지는 누름을 여기서 멈춘다.
    const keep = (_e, cx) => cx.stop_propagation();
    const minimized = Boolean(props()?.minimized);
    const windowButton = (id, label, onClick) => div().id(id).size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", keep).on_click(onClick).child(label);
    // 스크롤 영역의 직접 자식이 곧 한 줄이어야 scroll_to_item 이 그 줄로 간다. 줄마다 가운데 정렬 틀을 씌운다.
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
