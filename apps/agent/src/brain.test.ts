import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { loadProject } from "@tenfold/core";
import { runTool } from "./actions.js";
import type { Confirmation } from "./actions.js";
import { Brain, HISTORY_LIMIT, MAX_TOOL_CALLS_PER_TURN, SYSTEM_PROMPT, trimHistory } from "./brain.js";
import type { AnthropicLike, Message, ToolRunner } from "./brain.js";
import { ConfirmStore } from "./confirm.js";
import { CHAT, fixture } from "./testkit.js";
import type { Fixture } from "./testkit.js";

let fx: Fixture;
beforeEach(() => {
  fx = fixture();
});
afterEach(() => fx.cleanup());

type Create = AnthropicLike["messages"]["create"];

function message(content: Anthropic.ContentBlock[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
  };
}
const text = (t: string): Anthropic.TextBlock => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({ type: "tool_use", id, name, input });

/** A fake client that replays scripted responses and records every request. */
function fakeClient(script: Anthropic.Message[]): { client: AnthropicLike; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: Create = async (params) => {
    calls.push(params);
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  };
  return { client: { messages: { create } }, calls };
}

function runner(store: ConfirmStore): ToolRunner {
  return {
    run: (call) => runTool({ ledger: fx.ledger, cfg: loadProject("test"), projectId: "test" }, call),
    stash: (c: Confirmation) => store.stash(CHAT, c),
  };
}

describe("Brain tool loop", () => {
  it("does not apply a confirmed tool until the founder taps Yes", async () => {
    const store = new ConfirmStore();
    const { client, calls } = fakeClient([
      message([text("Let me set that up."), toolUse("tu1", "set_distribution", { enabled: true, pctOfVaultPerDay: 2, mode: "twap" })], "tool_use"),
      message([text("Distribution would sell 0.5%/day (your cap), twap. Confirm below.")], "end_turn"),
    ]);
    const brain = new Brain(client, "fake-model", SYSTEM_PROMPT);
    const history: Message[] = [];
    const reply = await brain.respond(history, "sell 2% a day evenly", runner(store));

    expect(reply.text).toBe("Distribution would sell 0.5%/day (your cap), twap. Confirm below.");
    expect(reply.pendingConfirmation).toBeDefined();
    expect(reply.pendingConfirmation!.summary).toMatch(/clamped/);
    // nothing changed on disk yet
    expect(loadProject("test").strategy.distribution).toMatchObject({ pctOfVaultPerDay: 0.3, mode: "strength" });
    expect(store.size()).toBe(1);

    // the tool result told the model about the clamp and the pending confirmation
    const second = calls[1]!;
    const lastMsg = second.messages[second.messages.length - 1]!;
    const resultBlock = (lastMsg.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(resultBlock.type).toBe("tool_result");
    expect(resultBlock.tool_use_id).toBe("tu1");
    expect(String(resultBlock.content)).toMatch(/NOTHING is applied until they tap Yes/);
    expect(String(resultBlock.content)).toMatch(/"clamped":true/);
    expect(second.system).toBe(SYSTEM_PROMPT);
    expect(second.tools?.length).toBeGreaterThan(5);

    // No: discarded
    const declined = store.resolve(reply.pendingConfirmation!.id, CHAT, false);
    expect(declined.status).toBe("declined");
    expect(loadProject("test").strategy.distribution.mode).toBe("strength");
    expect(store.resolve(reply.pendingConfirmation!.id, CHAT, true).status).toBe("missing");

    // Yes on a fresh one: applied
    const brain2 = new Brain(
      fakeClient([
        message([toolUse("tu2", "set_distribution", { enabled: true, pctOfVaultPerDay: 2, mode: "twap" })], "tool_use"),
        message([text("Confirm below.")], "end_turn"),
      ]).client,
      "fake-model",
      SYSTEM_PROMPT,
    );
    const reply2 = await brain2.respond(history, "again please", runner(store));
    const applied = store.resolve(reply2.pendingConfirmation!.id, CHAT, true);
    expect(applied.status).toBe("applied");
    expect(applied.result?.ok).toBe(true);
    expect(loadProject("test").strategy.distribution).toMatchObject({ enabled: true, pctOfVaultPerDay: 0.5, mode: "twap" });

    // history keeps plain text turns only
    expect(history).toHaveLength(4);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1]!.content).toBe(reply.text);
  });

  it("applies instant tools right away and reports a tool error to the model", async () => {
    const store = new ConfirmStore();
    const { client, calls } = fakeClient([
      message([toolUse("a", "lower_daily_cap", { pct: 0.2 }), toolUse("b", "set_defense_level", { price: -1, budgetSol: 1, action: "add" })], "tool_use"),
      message([text("Cap lowered to 0.2%.")], "end_turn"),
    ]);
    const reply = await new Brain(client, "m", SYSTEM_PROMPT).respond([], "lower the cap to 0.2", runner(store));
    expect(reply.pendingConfirmation).toBeUndefined();
    expect(loadProject("test").rules.dailySellCapPct).toBe(0.2);
    const results = calls[1]!.messages[calls[1]!.messages.length - 1]!.content as Anthropic.ToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results[0]!.is_error).toBe(false);
    expect(results[1]!.is_error).toBe(true);
    expect(String(results[1]!.content)).toMatch(/price must be a positive number/);
  });

  it("rejects a second confirmation in the same turn", async () => {
    const store = new ConfirmStore();
    const { client, calls } = fakeClient([
      message([toolUse("a", "resume", {}), toolUse("b", "set_defense_budget", { budgetSol: 20, maxPerDaySol: 5 })], "tool_use"),
      message([text("ok")], "end_turn"),
    ]);
    runTool({ ledger: fx.ledger, cfg: loadProject("test"), projectId: "test" }, { name: "pause" });
    const reply = await new Brain(client, "m", SYSTEM_PROMPT).respond([], "resume and raise the budget", runner(store));
    expect(reply.pendingConfirmation?.summary).toMatch(/^Resume/);
    const results = calls[1]!.messages[calls[1]!.messages.length - 1]!.content as Anthropic.ToolResultBlockParam[];
    expect(results[1]!.is_error).toBe(true);
    expect(String(results[1]!.content)).toMatch(/already waiting/);
    expect(store.size()).toBe(1);
  });

  it("caps tool calls per turn and forces a text answer", async () => {
    const store = new ConfirmStore();
    const script: Anthropic.Message[] = [];
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN; i++) script.push(message([toolUse(`t${i}`, "get_status", {})], "tool_use"));
    script.push(message([text("Here is the status.")], "end_turn"));
    const { client, calls } = fakeClient(script);
    const reply = await new Brain(client, "m", SYSTEM_PROMPT).respond([], "status?", runner(store));
    expect(reply.text).toBe("Here is the status.");
    expect(calls).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 1);
    expect(calls[MAX_TOOL_CALLS_PER_TURN]!.tool_choice).toEqual({ type: "none" });
    expect(calls[0]!.tool_choice).toBeUndefined();
  });

  it("trims history to the last 30 messages starting on a user turn", () => {
    const h: Message[] = [];
    for (let i = 0; i < 41; i++) h.push({ role: i % 2 === 0 ? "user" : "assistant", content: String(i) });
    trimHistory(h);
    expect(h.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(h[0]!.role).toBe("user");
  });
});

describe("ConfirmStore", () => {
  it("expires entries after 10 minutes and scopes them to the chat", () => {
    let now = 0;
    const store = new ConfirmStore(() => now);
    const id = store.stash(CHAT, { summary: "x", apply: () => ({ ok: true, message: "applied" }) });
    expect(store.resolve(id, "other", true).status).toBe("wrong_chat");
    now = 10 * 60_000 + 1;
    expect(store.resolve(id, CHAT, true).status).toBe("expired");
    expect(store.size()).toBe(0);
  });
});
