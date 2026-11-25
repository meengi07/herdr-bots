"""Parser checks on sample records (shapes from each agent's docs or real files). Run: /usr/bin/python3 -I tests/test_botsagent.py"""
import json
import os
import sqlite3
import sys
import tempfile
from importlib.machinery import SourceFileLoader
import importlib.util

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
loader = SourceFileLoader("botsagent", os.path.join(ROOT, "runtime", "bin", "botsagent"))
agent = importlib.util.module_from_spec(importlib.util.spec_from_loader("botsagent", loader))
loader.exec_module(agent)
P = agent.PROVIDERS


def write(lines):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    f.write("\n".join(json.dumps(x) for x in lines) + "\n")
    f.close()
    return f.name


def check(name, messages, tool="bash"):
    roles = [(m["role"], m["text"], [t["name"] for t in m.get("tools", [])]) for m in messages]
    want = [("user", "[room: r · m1] hi", []), ("assistant", "done", [tool])]
    assert roles == want, (name, roles)
    assert agent.answer_after(messages, "m1") == {"text": "done"}, name
    print("ok", name)


ts = "2026-11-25T10:00:00.000Z"
check("claude", P["claude"].parse(write([
    {"type": "user", "uuid": "u", "timestamp": ts, "message": {"content": '<hc from="t1">[room: r · m1] hi</hc>'}},
    {"type": "assistant", "uuid": "a", "timestamp": ts, "message": {"content": [
        {"type": "tool_use", "name": "bash", "input": {"command": "ls"}}, {"type": "text", "text": "done"}]}}])))
check("codex", P["codex"].parse(write([
    {"type": "event_msg", "timestamp": ts, "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u", "content": [{"type": "text", "text": "[room: r · m1] hi"}]}}},
    {"type": "event_msg", "timestamp": ts, "payload": {"type": "item_completed", "item": {"type": "CommandExecution", "id": "c", "command": "ls"}}},
    {"type": "event_msg", "timestamp": ts, "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "id": "a", "content": [{"type": "Text", "text": "done"}], "phase": "final_answer"}}}])), tool="shell")
check("codex-old", P["codex"].parse(write([
    {"type": "response_item", "timestamp": ts, "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "[room: r · m1] hi"}]}},
    {"type": "response_item", "timestamp": ts, "payload": {"type": "function_call", "name": "bash", "arguments": "{\"command\": \"ls\"}"}},
    {"type": "response_item", "timestamp": ts, "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}}])))
check("pi", P["pi"].parse(write([
    {"type": "session", "version": 3, "id": "s", "cwd": "/x"},
    {"type": "message", "id": "u", "timestamp": ts, "message": {"role": "user", "content": "[room: r · m1] hi"}},
    {"type": "message", "id": "a", "timestamp": ts, "message": {"role": "assistant", "content": [
        {"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}, {"type": "text", "text": "done"}]}}])))
check("copilot", P["copilot"].parse(write([
    {"type": "user.message", "id": "u", "timestamp": ts, "data": {"content": "[room: r · m1] hi"}},
    {"type": "assistant.message", "id": "a", "timestamp": ts, "data": {"content": "", "toolRequests": [{"name": "bash", "arguments": {"command": "ls"}}]}},
    {"type": "assistant.message", "id": "b", "timestamp": ts, "data": {"content": "done"}}])))
up = lambda event, **kw: {"method": "session/update", "params": {"update": {"sessionUpdate": event, **kw}}}
check("grok", P["grok"].parse(write([
    up("user_message_chunk", content={"type": "text", "text": "[room: r · m1] "}), up("user_message_chunk", content={"type": "text", "text": "hi"}),
    up("tool_call", kind="bash", title="ls"), up("agent_message_chunk", content={"type": "text", "text": "do"}),
    up("agent_message_chunk", content={"type": "text", "text": "ne"})])))
check("kimi", P["kimi"].parse(write([
    {"role": "_system_prompt", "content": "x"}, {"role": "user", "content": "[room: r · m1] hi"},
    {"role": "assistant", "content": "", "tool_calls": [{"type": "function", "id": "c", "function": {"name": "bash", "arguments": "{\"command\":\"ls\"}"}}]},
    {"role": "tool", "content": "out"}, {"role": "assistant", "content": [{"type": "text", "text": "done"}]}])))
check("gemini", P["gemini"].parse(write([
    {"sessionId": "s", "projectHash": "h"}, {"id": "u", "timestamp": ts, "type": "user", "content": [{"text": "[room: r · m1] hi"}]},
    {"$set": {"x": 1}}, {"id": "a", "timestamp": ts, "type": "gemini", "content": "done", "toolCalls": [{"name": "bash", "args": {"command": "ls"}}]}])))

home = tempfile.mkdtemp()
os.makedirs(os.path.join(home, ".crush"))
db = sqlite3.connect(os.path.join(home, ".crush", "crush.db"))
db.executescript("create table sessions (id text primary key, parent_session_id text, updated_at int);"
                 "create table messages (id text primary key, session_id text, role text, parts text, created_at int);")
db.execute("insert into sessions values ('s1', null, 5)")
db.executemany("insert into messages values (?, 's1', ?, ?, ?)", [
    ("u", "user", json.dumps([{"type": "text", "data": {"text": "[room: r · m1] hi"}}]), 1),
    ("a", "assistant", json.dumps([{"type": "tool_call", "data": {"name": "bash", "input": "{\"command\":\"ls\"}"}}, {"type": "text", "data": {"text": "done"}}]), 2)])
db.commit()
sid, path = P["crush"].session_files(home)[0]
assert sid == "s1" and P["crush"].mtime(path) == 5.0
check("crush", P["crush"].parse(path))

assert agent.answer_after([{"role": "user", "text": "m9"}, {"role": "assistant", "text": "quiet", "tools": []}], "m9") == {"silent": True}
assert agent.answer_after([{"role": "user", "text": "m9"}], "m9") is None
assert agent.user_entry("u", '\n\n<pasted_content id="5">\n[room: r · m9]\nhi\n</pasted_content id="5">\n', None)["text"] == "[room: r · m9]\nhi"
assert P["codex"].argv("gpt-x", "low", "abc", False)[:2] == ["codex", "resume"] and P["codex"].argv("gpt-x", "low", None, True)[0] == "codex"
assert P["claude"].argv("m", "low", "id", True)[-2:] == ["--session-id", "id"]
assert "--model" not in P["pi"].argv("default", "default", None, False)
print("all ok")
