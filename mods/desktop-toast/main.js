// Modified by herdr-bots from Herdr's shipped "toast" mod (v0.1.16, Apache-2.0): also posts to macOS Notification Center (alerter) and shows a bot's message in its notification. See NOTICE.
// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, exec, hc, agents, terminals, shared, appHome, home, readTextFile, checking } from "herdr";

const TEXT = {
  ko: { blocked: "응답 필요", done: "작업 완료", blockedMsg: "입력을 기다리고 있습니다", doneMsg: "작업을 마쳤습니다",
        botNeeds: "확인이 필요해요", botNew: "새 메시지", roomNeeds: "방에서 확인이 필요해요", roomDone: "방에서 답했어요", roomOpen: "방을 열어 확인하세요" },
  en: { blocked: "needs you", done: "finished", blockedMsg: "Waiting for your input", doneMsg: "Finished its work",
        botNeeds: "Needs you", botNew: "New message", roomNeeds: "Needs you in a room", roomDone: "Replied in a room", roomOpen: "Open the room to see it" },
};

// alerter blocks until the notification closes. Detach it so it outlives the toast; a click brings Herdr forward and runs the commands in $4 (one "name<TAB>JSON args" per line).
const PUSH = '"$0" --sender dev.herdr.app --title "$1" --subtitle "$2" --message "$3" --timeout 60 --json ${6:+--content-image "$6"}'
  + ' | grep -q contentsClicked && open -b dev.herdr.app && printf "%s\\n" "$4" | while IFS="$(printf "\\t")" read -r name args; do [ -n "$name" ] && "$5" do "$name" "$args"; done';

// A bot's last reply in its 1:1 session (botsagent reads any agent's session), Markdown stripped, on one line.
async function lastBotReply(bot) {
  const r = await exec(`${home()}/.herdr-bots/bin/botsagent`, ["last-reply", bot]);
  const text = r.code === 0 ? JSON.parse(r.stdout).text : "";
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
}

// A bot notification opens that bot's floating chat window, which the Bots mod opens (command bots.chat-<bot>).
function botActions(bot) {
  return [[`bots.chat-${bot}`, {}]];
}

async function push(p) {
  const config = JSON.parse((await readTextFile(`${appHome()}/mods/desktop-toast/config.json`)) ?? "{}");
  // config.json lang: "auto" (default) follows the system language (shared("bots.lang") from the Bots mod); "ko" or "en" fixes it.
  const lang = !config.lang || config.lang === "auto" ? shared("bots.lang") ?? "en" : config.lang;
  const text = TEXT[lang] ?? TEXT.en;
  const address = p.action?.name === "agent.focus" ? p.action.args?.terminal : null;
  const agent = address ? agents().find((a) => a.address === address) : null;
  let title = p.title ?? "";
  let subtitle = "";
  let message = p.body ?? "";
  let image = "";
  let actions = p.action?.name ? [[p.action.name, p.action.args ?? {}]] : [];
  if (agent) {
    const facts = await hc(["get", address, "--json"]);
    const status = facts.code === 0 ? JSON.parse(facts.stdout).status ?? {} : {};
    // done turns into idle as soon as the user looks, so also tell it apart by the toast level.
    const blocked = agent.status === "blocked" || p.level === "error";
    const labels = terminals().find((x) => x.address === address)?.labels ?? {};
    const bot = labels["herdr.bot"];
    const room = labels["herdr.room"];
    image = bot ? `${appHome()}/mods/bots/lamb.png` : "";
    title = `${agent.program?.name ?? agent.app ?? "Agent"} ${blocked ? text.blocked : text.done}`;
    subtitle = [agent.title, `${agent.space_name} / ${agent.tab_name || agent.tab_index}`].filter(Boolean).join(" · ");
    message = status.msg || (blocked ? text.blockedMsg : text.doneMsg);
    if (bot) {
      // Bots read like a chat app: the title is the bot's name, the body its message (or what it asks when it needs you).
      title = shared("bots.titles")?.[bot] || bot;
      subtitle = blocked ? text.botNeeds : text.botNew;
      message = blocked ? status.msg || text.blockedMsg : (await lastBotReply(bot)) || text.doneMsg;
      actions = botActions(bot);
      if (room) {
        // A room session's notification: the reply is already in the room, so open the room window.
        subtitle = blocked ? text.roomNeeds : text.roomDone;
        message = blocked ? status.msg || text.blockedMsg : text.roomOpen;
        actions = [[`bots.room-${room}`, {}]];
      }
    }
  }
  const commands = actions.map(([name, args]) => `${name}\t${JSON.stringify(args)}`).join("\n");
  // Without alerter only the desktop notification is skipped (the in-app toast still shows).
  const script = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; command -v "$0" >/dev/null 2>&1 || exit 0; (${PUSH}) >/dev/null 2>&1 &`;
  await exec("/bin/sh", ["-c", script, "alerter", title, subtitle, message, commands, "herdr-app", image]);
}

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class Toast extends View {
  init(_props, cx) {
    if (checking()) return;
    const p = props() ?? {};
    cx.spawn(async () => { try { await push(p); } catch (e) { console.error("desktop-toast", e); } });
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
          .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
