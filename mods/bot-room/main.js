// Room window: shows the room's history (local database, botsdb) as colored bubbles per bot and posts your messages to the room.
// Sending to bots and posting their replies is the Bots mod relay's job. This window reads, and writes only your messages.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, ScrollHandle, TextView, InputState, Input } from "gpui-base";
import { props, agents, terminals, run, theme, exec, home, checking, shared, closeOverlay, openOverlay, watchFolder } from "herdr";

const LAMB = "mods/bots/lamb.png";
const COLUMN = 720;
const ROUNDS = 3; // same as the relay (bots mod): bot rounds per human message
async function botsdb(...args) {
  const r = await exec(`${home()}/.herdr-bots/bin/botsdb`, args);
  if (r.code !== 0) throw new Error(`botsdb ${args[0]}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}
const pad = (n) => String(n).padStart(2, "0");
const MODELS = [["claude-fable-5-2", "Fable 5.2"], ["claude-opus-5-5", "Opus 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]];
const EFFORTS = ["low", "medium", "high"];
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
// UI text follows the system language (the Bots mod puts it in shared("bots.lang")): Korean when Korean comes first, English otherwise.
const tr = (ko, en) => (shared("bots.lang") === "ko" ? ko : en);
const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// This window looks at the bot's session for this room (not its 1:1 session).
let ROOM = "";
const botTerminal = (bot) => terminals().find((x) => x.labels?.["herdr.bot"] === bot && x.labels?.["herdr.room"] === ROOM && x.state === "live") ?? null;
const botStatus = (bot) => {
  const terminal = botTerminal(bot);
  return terminal ? agents().find((a) => a.address === terminal.address)?.status ?? "idle" : null;
};

export default class BotRoom extends View {
  init(_props, cx) {
    this.room = props()?.room ?? "";
    ROOM = this.room;
    this.seq = 0;           // last event number read; only later events are read
    this.meta = { title: this.room, members: [] };
    this.events = [];
    this.optimistic = [];   // my messages already shown but not yet stored
    this.written = [];
    // A room just created with the sidebar + opens with the bot picker expanded.
    this.adding = Boolean(props()?.adding);
    this.showMembers = false;
    this.editingTitle = false;
    this.titleInput = InputState.new({ value: "", placeholder: tr("방 이름", "Room name") });
    this.titleInput.on("submit", (_e, cx) => cx.spawn(async (cx) => { await this.saveTitle(cx); }));
    this.configs = {};             // { model, effort } per bot (database)
    this.pendingRestart = new Set(); // bots to restart after their turn to apply a model change
    this.restarting = new Set();
    this.scroll = ScrollHandle.new();
    this.scrollTo = null;
    this.input = TextareaState.new({ placeholder: tr("메시지 · @이름으로 봇 지정 (지정 없으면 방장에게)", "Message · @name picks a bot (otherwise the room host)") });
    this.input.set_auto_grow(2, 8);
    this.input.on("submit", (e, cx) => { if (!e.shift) this.send(cx); });
    if (checking()) return;
    cx.spawn(async (cx) => { await this.load(); this.scrollTo = "end"; cx.notify(); });
    // Room history is in ~/.herdr-bots/bots.db; read new events as soon as that folder changes.
    cx.spawn(async (cx) => {
      for (;;) {
        const changed = await watchFolder(`${home()}/.herdr-bots`).catch(() => null);
        if (changed === null) return;
        // Reads touch bots.db-shm (ours and the sidebar's); only writes (bots.db-wal) mean new events.
        if (changed.length && changed.every((path) => path.endsWith("-shm"))) continue;
        if (!this.loadingNow) { this.loadingNow = true; try { if (await this.load()) cx.notify(); } finally { this.loadingNow = false; } }
      }
    });
    cx.spawn(async (cx) => { await this.loadConfigs(); cx.notify(); });
    // Fallback check, and status refresh while members work. A bot waiting for a model change is restarted once it is idle.
    cx.timer.every(2000, (cx) => cx.spawn(async (cx) => {
      for (const bot of [...this.pendingRestart]) if (botStatus(bot) !== "working") await this.applyModel(bot, cx);
      const working = this.meta.members.some((b) => botStatus(b) === "working");
      // Folder changes already reload; read here only while a member works or every 30 s, since each read starts a python3 process.
      const due = working || Date.now() - (this.loadedAt ?? 0) > 30_000;
      const changed = this.loadingNow || !due ? false : await this.load();
      if (changed || working) cx.notify();
    }));
  }

  async load() {
    this.loadedAt = Date.now();
    const read = await botsdb("room-read", this.room, String(this.seq));
    const meta = read.meta;
    // The read right after sending and the read on a folder change can overlap and return the same event; drop numbers already seen.
    const events = read.events.filter((e) => e.seq > this.seq);
    const metaChanged = JSON.stringify(meta) !== JSON.stringify(this.meta);
    if (!events.length && !metaChanged) return false;
    this.meta = meta;
    // Close this window too when the room was left from the sidebar.
    if (meta.archived && props()?.overlay) { closeOverlay(props().overlay); return false; }
    if (events.length) {
      this.seq = events.at(-1).seq;
      this.written = [...this.written, ...events];
      this.scrollTo = "end";
    }
    const ids = new Set(this.written.map((e) => e.id));
    this.optimistic = this.optimistic.filter((e) => !ids.has(e.id));
    this.events = [...this.written, ...this.optimistic];
    // An expanded window means everything so far has been read.
    if (this.seq && !props()?.minimized) botsdb("room-mark-read", this.room, String(this.seq)).catch(() => {});
    return true;
  }

  roomTitle() {
    return this.meta.title || tr("이름 없는 방", "Untitled room");
  }

  startRename(cx) {
    this.editingTitle = true;
    this.titleInput.set_value(this.meta.title ?? "");
    this.titleInput.focus();
    cx.notify();
  }

  async saveTitle(cx) {
    await botsdb("room-rename", this.room, this.titleInput.value().trim());
    this.editingTitle = false;
    run("bots.reload");
    await this.load();
    cx.notify();
  }

  // Remove a member: stop its session for this room and drop it from the members (history stays). Added again, it starts a new room session.
  async removeMember(bot, cx) {
    await exec(`${home()}/.herdr-bots/bin/herdr-bot`, ["stop-room", bot, this.room]).catch(() => {});
    await botsdb("room-remove-member", this.room, bot);
    run("bots.reload");
    await this.load();
    cx.notify();
  }

  async setHost(bot, cx) {
    await botsdb("room-set-host", this.room, bot);
    run("bots.reload");
    await this.load();
    cx.notify();
  }

  title(bot) {
    return shared("bots.titles")?.[bot] || bot;
  }

  color(bot, t) {
    return shared("bots.colors")?.[bot] ?? t.accent;
  }

  // Input as text: token spans become the token's text (@name).
  plainText() {
    const content = this.input.content();
    const spans = [...content.tokens].sort((a, b) => a.range.start - b.range.start);
    let out = "";
    let at = 0;
    for (const span of spans) {
      out += content.text.slice(at, span.range.start) + span.token.text;
      at = span.range.end;
    }
    return out + content.text.slice(at);
  }

  // Draw a sent message at once (without waiting for the write), and wake the relay as soon as the write ends.
  send(cx) {
    const text = this.plainText().trim();
    if (!text) return;
    if (this.meta.members.length === 0) { this.error = tr("먼저 「+ 봇 추가」로 봇을 넣어 주세요.", "Add a bot first with “+ Add bot”."); cx.notify(); return; }
    this.input.set_value("");
    this.error = "";
    const event = { t: "msg", id: newId(), from: "owner", text, hop: 0, at: new Date().toISOString() };
    this.optimistic.push(event);
    this.events = [...this.events, event];
    this.scrollTo = "end";
    cx.notify();
    cx.spawn(async (cx) => {
      await botsdb("room-append", this.room, JSON.stringify(event));
      run("bots.relay");
      await this.load();
      cx.notify();
    });
  }

  async loadConfigs() {
    const bots = await botsdb("bots");
    this.configs = Object.fromEntries(bots.map((b) => [b.id, { model: b.model, effort: b.effort }]));
  }

  // Changing a member's model or effort saves it and restarts that bot (the conversation continues); while working, after the turn.
  async chooseModel(bot, model, effort, cx) {
    await botsdb("set-model", bot, model, effort);
    this.configs[bot] = { model, effort };
    this.pendingRestart.add(bot);
    cx.notify();
    if (botStatus(bot) !== "working") await this.applyModel(bot, cx);
  }

  async applyModel(bot, cx) {
    this.pendingRestart.delete(bot);
    this.restarting.add(bot);
    cx.notify();
    await exec(`${home()}/.herdr-bots/bin/herdr-bot`, ["restart", bot], { timeout: 120_000 }).catch(() => {});
    // Stop this room's session; the next relay starts it again with the new model (the conversation continues).
    await exec(`${home()}/.herdr-bots/bin/herdr-bot`, ["stop-room", bot, this.room]).catch(() => {});
    this.restarting.delete(bot);
    cx.notify();
  }

  membersPanel(t, keep) {
    const label = Object.fromEntries(MODELS);
    const option = (id, text, on, onClick) => div().id(id).px(8).py(2).rounded(999).text_size(11.5).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(text);
    const row = (bot) => {
      const config = this.configs[bot] ?? {};
      const state = this.restarting.has(bot) ? tr("다시 띄우는 중…", "Restarting…") : this.pendingRestart.has(bot) ? tr("작업 끝나면 적용", "Applies after this turn") : "";
      const isHost = this.meta.members[0] === bot;
      const small = (id, text, onClick, danger) => div().id(id).px(8).py(1).rounded(6).text_size(11.5).cursor_pointer()
        .text_color(danger ? t.blocked : t.muted).hover((x) => x.bg(t.hover)).on_click(onClick).child(text);
      return v_flex().gap(4).py(4)
        .child(h_flex().gap(8).items_center()
          .child(div().size(8).rounded(4).flex_none().bg(this.color(bot, t)))
          .child(div().text_size(12.5).font_semibold().text_color(this.color(bot, t)).child(this.title(bot)))
          .when(isHost, (el) => el.child(div().px(6).rounded(4).bg(t.selected).text_size(11).text_color(t.muted).child(tr("방장", "host"))))
          .child(div().text_size(11.5).text_color(t.dim).child(`${label[config.model] ?? config.model ?? ""} · ${config.effort ?? ""}`))
          .when(Boolean(state), (el) => el.child(div().text_size(11.5).text_color(t.working).child(state)))
          .child(div().flex_1())
          .when(!isHost, (el) => el.child(small(`host-${bot}`, tr("방장으로", "Make host"), (_e, cx) => cx.spawn(async (cx) => { await this.setHost(bot, cx); }))))
          .child(small(`remove-${bot}`, tr("빼기", "Remove"), (_e, cx) => cx.spawn(async (cx) => { await this.removeMember(bot, cx); }), true)))
        .child(h_flex().gap(4).flex_wrap().pl(16)
          .children(MODELS.map(([id, text]) => option(`m-${bot}-${id}`, text, config.model === id, (_e, cx) => cx.spawn(async (cx) => { await this.chooseModel(bot, id, config.effort ?? "low", cx); }))))
          .child(div().w(8))
          .children(EFFORTS.map((e) => option(`e-${bot}-${e}`, e, config.effort === e, (_e, cx) => cx.spawn(async (cx) => { await this.chooseModel(bot, config.model ?? "claude-sonnet-5-5", e, cx); })))));
    };
    return v_flex().flex_none().px(18).py(8).gap(2).border_b_1().border_color(t.border).on_mouse_down("left", keep)
      .when(this.meta.members.length === 0, (el) => el.child(div().text_size(12).text_color(t.dim).child(tr("아직 멤버가 없습니다", "No members yet"))))
      .children(this.meta.members.map(row))
      .child(div().pt(2).text_size(11).text_color(t.dim).child(tr("모델을 고르면 그 봇을 다시 띄워 적용합니다(대화는 이어집니다). 첫 멤버가 방장으로, 멘션 없는 말을 받습니다.",
        "Picking a model restarts that bot (the conversation continues). The first member is the host and gets messages without a mention.")));
  }

  async addMember(bot, cx) {
    await botsdb("room-add", this.room, bot);
    run("bots.reload");
    await this.load();
    cx.notify();
  }

  // Mention button: move the cursor to the end, insert a chip (token) in the bot's color, add a space. On send the token's text (@name) goes into the message.
  insertMention(bot) {
    const end = this.input.content().text.length;
    this.input.set_selected_range({ start: end, end });
    if (end > 0 && !/\s$/.test(this.input.content().text)) this.input.replace(" ");
    const name = `@${this.title(bot)}`;
    this.input.replace_with_token({ id: `mention:${bot}:${Date.now()}`, text: name, label: name });
    this.input.replace(" ");
    this.input.focus();
  }

  mentionToken(context, t) {
    const bot = context.token.id.split(":")[1];
    const color = this.color(bot, t);
    return div().px(5).rounded(5).bg(color + "1f").text_color(color).font_medium().child(context.token.label ?? context.token.text);
  }

  resize(minimized) {
    openOverlay({ kind: "window", mod: "bot-room", key: `room-${this.room}`, keep: true, width: minimized ? 320 : 620, height: minimized ? 52 : 720, props: { room: this.room, minimized } });
  }

  // Turn @mentions of room members into links (bot:<id>), like ticket links; a click opens that bot's chat window.
  // TextView takes no CSS, so links use the theme's link color, not the bot's color.
  markdown(text) {
    const titles = shared("bots.titles") ?? {};
    return text.replace(/@([^\s@,.!?:;()[\]「」]+)/g, (whole, word) => {
      const bot = this.meta.members.find((b) => b === word || titles[b] === word);
      return bot ? `[@${word}](bot:${bot})` : whole;
    });
  }

  messageText(id, text) {
    return TextView.markdown(id, this.markdown(text)).on_link_click((url) => {
      if (/^https?:\/\//i.test(url)) { exec("/usr/bin/open", [url]).catch(() => {}); return; }
      // Links can come from text a bot wrote: open only bots that are members.
      const bot = url.startsWith("bot:") ? url.slice(4) : "";
      if (!this.meta.members.includes(bot)) return;
      openOverlay({ kind: "window", mod: "bot-chat", key: `chat-${bot}`, keep: true, width: 520, height: 680, props: { bot } });
    });
  }

  ownerRow(m, t) {
    return v_flex().w_full().items_end().gap(4)
      .child(div().max_w("80%").px(14).py(10).rounded(18).bg(t.selected).text_color(t.foreground).child(this.messageText(`r-${m.id}`, m.text)))
      .child(div().text_size(11).text_color(t.dim).child(m.at ? clock(new Date(m.at)) : ""));
  }

  botRow(m, t) {
    const color = this.color(m.from, t);
    return h_flex().w_full().items_start().gap(12)
      .child(div().flex_none().p(1).rounded(8).border_2().border_color(color).child(image(LAMB).size(26).rounded(6)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12.5).font_semibold().text_color(color).child(this.title(m.from)))
          .child(div().text_size(11.5).text_color(t.dim).child(m.at ? clock(new Date(m.at)) : "")))
        .child(div().px(12).py(8).bg(color + "0f").rounded(10).when(Boolean(m.needs), (el) => el.border_1().border_color(t.blocked))
          .text_color(t.foreground).child(this.messageText(`r-${m.id}`, m.text)))
        .when(Boolean(m.needs), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(tr("확인이 필요해요 — 이 방에 답해 주세요", "Needs you — reply in this room")))));
  }

  // One line for a bot calling another bot: "Reviewer -> Deployer · 2/3" (rounds)
  handoffRow(send, from, t) {
    return h_flex().w_full().justify_center().child(div().px(12).py(2).rounded(999).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.muted).child(tr(`${this.title(from)} → ${this.title(send.bot)} 전달 · ${send.hop}/${ROUNDS}`, `${this.title(from)} → ${this.title(send.bot)} · round ${send.hop}/${ROUNDS}`)));
  }

  // Stop: record it so the relay does not continue earlier requests, and stop working members' sessions for this room.
  async stopRoom(cx) {
    await botsdb("room-append", this.room, JSON.stringify({ t: "stop", id: newId(), at: new Date().toISOString() }));
    for (const bot of this.meta.members) {
      const terminal = botTerminal(bot);
      if (terminal && botStatus(bot) === "working") await exec("hc", ["interrupt", terminal.address]).catch(() => {});
    }
    await this.load();
    cx.notify();
  }

  async continueRoot(root, cx) {
    await botsdb("room-append", this.room, JSON.stringify({ t: "continue", id: root, at: new Date().toISOString() }));
    run("bots.relay");
    await this.load();
    cx.notify();
  }

  // Requests paused at the bot reply limit that have not been continued.
  pausedRoots() {
    const continues = (root) => this.events.filter((e) => e.t === "continue" && e.id === root).length;
    const stopSeq = Math.max(0, ...this.events.filter((e) => e.t === "stop").map((e) => e.seq ?? 0));
    return this.events.filter((e) => e.t === "pause" && (e.seq ?? 0) > stopSeq && Number(e.bot) > continues(e.id))
      .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  }

  statusRows(t) {
    const rows = [];
    const open = new Set(this.events.filter((e) => e.t === "send").map((e) => e.bot));
    for (const e of this.events.filter((x) => x.t === "done")) open.delete(e.bot);
    for (const bot of this.meta.members) {
      const status = botStatus(bot);
      const color = this.color(bot, t);
      if (status === "blocked") {
        const terminal = botTerminal(bot);
        rows.push(h_flex().w_full().px(14).py(10).gap(10).items_center().rounded(12).bg(t.blocked + "10").border_1().border_color(t.blocked + "40")
          .child(div().size(8).rounded(4).flex_none().bg(color))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(tr(`${this.title(bot)} 이(가) 확인을 기다립니다`, `${this.title(bot)} is waiting for you`)))
          .child(div().id(`peek-${bot}`).flex_none().px(10).py(4).rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
            .on_click(() => terminal && run("terminal.peek", { terminal: terminal.address })).child(tr("터미널에서 답하기", "Answer in terminal"))));
      } else if (status === "working" && open.has(bot)) {
        rows.push(h_flex().gap(8).items_center().text_size(12.5).text_color(t.muted)
          .child(div().size(7).rounded(4).flex_none().bg(color))
          .child(tr(`${this.title(bot)} 작업 중`, `${this.title(bot)} is working`)));
      }
    }
    for (const pause of this.pausedRoots()) {
      rows.push(h_flex().w_full().px(14).py(10).gap(10).items_center().rounded(12).border_1().border_color(t.border).bg(t.surface)
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(tr("봇끼리 주고받은 답이 많아 멈췄습니다.", "Paused: the bots exchanged many replies.")))
        .child(div().id(`continue-${pause.id}`).flex_none().px(10).py(4).rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12)
          .cursor_pointer().on_click((_e, cx) => cx.spawn(async (cx) => { await this.continueRoot(pause.id, cx); })).child(tr("계속", "Continue"))));
    }
    return rows;
  }

  render(cx) {
    const t = theme();
    const minimized = Boolean(props()?.minimized);
    const keep = (_e, cx) => cx.stop_propagation();
    const chip = (text) => div().px(10).py(2).rounded(999).border_1().border_color(t.border).text_size(12).text_color(t.muted).child(text);
    const windowButton = (id, label, onClick) => div().id(id).size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", keep).on_click(onClick).child(label);
    const line = (child, top = 9, bottom = 9) => h_flex().w_full().flex_none().justify_center().pt(top).pb(bottom)
      .child(v_flex().w_full().max_w(COLUMN).px(20).child(child));

    const msgs = new Map(this.events.filter((e) => e.t === "msg").map((e) => [e.id, e]));
    const items = [];
    for (const e of this.events) {
      if (e.t === "msg") items.push(line(e.from === "owner" ? this.ownerRow(e, t) : this.botRow(e, t)));
      // Relaying a human message needs no line; only a bot calling a bot is shown.
      if (e.t === "send" && msgs.get(e.id)?.from && msgs.get(e.id).from !== "owner") items.push(line(this.handoffRow(e, msgs.get(e.id).from, t), 2, 2));
    }
    if (items.length === 0) items.push(line(div().text_color(t.dim).child(this.meta.members.length ? tr("첫 메시지를 보내 보세요. @이름으로 봇을 고를 수 있습니다.", "Send the first message. @name picks a bot.") : tr("「+ 봇 추가」로 이 방에 봇을 넣으세요. 처음 넣은 봇이 방장입니다.", "Add bots with “+ Add bot”. The first one becomes the host."))));
    const children = [line(div(), 12, 0), ...items, ...this.statusRows(t).map((row) => line(row, 4, 4)), line(div(), 0, 12)];
    if (this.scrollTo) { this.scroll.scroll_to_item(children.length - 1); this.scrollTo = null; }

    const colors = shared("bots.colors") ?? {};
    const allBots = Object.keys(colors);
    const addable = allBots.filter((b) => !this.meta.members.includes(b));

    return v_flex().size_full().min_h(0).bg(t.background).text_size(14)
      .child(h_flex().h(52).cursor_grab().flex_none().px(minimized ? 14 : 18).gap(10).items_center().border_b_1().border_color(t.border)
        .when(!this.editingTitle, (el) => el.child(div().id("room-title").min_w(0).truncate().font_semibold().cursor_pointer()
          .text_color(this.meta.title ? t.foreground : t.muted).tooltip(tr("눌러서 이름 바꾸기", "Click to rename"))
          .on_mouse_down("left", keep).on_click((_e, cx) => this.startRename(cx)).child(this.roomTitle())))
        .when(this.editingTitle, (el) => el.child(div().w(200).on_mouse_down("left", keep)
          .on_key_down((e, cx) => { if (e.key === "escape") { this.editingTitle = false; cx.stop_propagation(); cx.notify(); } })
          .child(Input.new(this.titleInput).h(28).px(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))))
        .child(h_flex().flex_none().children(this.meta.members.slice(0, 5).map((bot, i) =>
          div().size(16).rounded(8).border_2().border_color(t.background).bg(colors[bot] ?? t.dim).when(i > 0, (el) => el.ml(-6)))))
        .when(!minimized, (el) => el.child(div().id("members").cursor_pointer().on_mouse_down("left", keep)
            .on_click((_e, cx) => { this.showMembers = !this.showMembers; if (this.showMembers) cx.spawn(async (cx) => { await this.loadConfigs(); cx.notify(); }); cx.notify(); })
            .child(chip(tr(`봇 ${this.meta.members.length} ▾`, `${this.meta.members.length} bots ▾`))))
          .child(div().id("add-bot").cursor_pointer().on_mouse_down("left", keep)
            .on_click((_e, cx) => { this.adding = !this.adding; cx.notify(); }).child(chip(this.adding ? tr("닫기", "Close") : tr("+ 봇 추가", "+ Add bot")))))
        .child(div().flex_1())
        .when(!minimized && this.meta.members.some((b) => botStatus(b) === "working"), (el) => el.child(div().id("stop-room").cursor_pointer()
          .on_mouse_down("left", keep).on_click((_e, cx) => cx.spawn(async (cx) => { await this.stopRoom(cx); }))
          .child(div().px(10).py(2).rounded(999).border_1().border_color(t.blocked).text_size(12).text_color(t.blocked).child(tr("■ 정지", "■ Stop")))))
        .when(Boolean(props()?.overlay), (el) => el
          .child(windowButton("minimize", minimized ? "□" : "–", () => this.resize(!minimized)))
          .child(windowButton("close", "✕", () => closeOverlay(props().overlay)))))
      .when(!minimized && this.showMembers, (el) => el.child(this.membersPanel(t, keep)))
      .when(!minimized && this.adding, (el) => el.child(h_flex().flex_none().px(18).py(8).gap(6).flex_wrap().border_b_1().border_color(t.border).on_mouse_down("left", keep)
        .when(addable.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child(tr("더 넣을 봇이 없습니다", "No more bots to add"))))
        .children(addable.map((bot) => h_flex().id(`add-${bot}`).gap(6).px(10).py(4).rounded(999).border_1().border_color(colors[bot]).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => cx.spawn(async (cx) => { await this.addMember(bot, cx); }))
          .child(div().size(8).rounded(4).bg(colors[bot])).child(div().text_size(12.5).text_color(t.foreground).child(this.title(bot)))))))
      .when(!minimized, (el) => el.child(v_flex().id("room-chat").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).on_mouse_down("left", keep)
        .children(children)))
      .when(!minimized, (el) => el.child(h_flex().flex_none().w_full().justify_center().px(20).pb(16).pt(6).on_mouse_down("left", keep)
        .child(v_flex().w_full().max_w(COLUMN).gap(6)
          .when(Boolean(this.error), (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(this.error)))
          .child(v_flex().w_full().px(14).pt(10).pb(10).gap(8).rounded(16).border_1().border_color(t.border).bg(t.surface)
            .child(Textarea.new(this.input).token((context) => this.mentionToken(context, t)))
            .child(h_flex().items_center().gap(6)
              .children(this.meta.members.map((bot) => div().id(`mention-${bot}`).px(8).py(1).rounded(999).border_1().border_color(colors[bot] ?? t.accent)
                .text_size(12).text_color(colors[bot] ?? t.accent).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.insertMention(bot)).child(`@${this.title(bot)}`)))
              .child(div().flex_1())
              .child(div().id("send").size(32).rounded(16).flex_none().flex().items_center().justify_center().cursor_pointer()
                .bg(t.solid).text_color(t.solid_foreground).on_click((_e, cx) => this.send(cx)).child("↑")))))));
  }
}
