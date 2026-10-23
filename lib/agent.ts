import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { dayKey, localTimeString } from "./dates";
import { getStore } from "./store";
import { runTool, summarise, toolDefinitions } from "./tools";
import type { UserState } from "./types";

/**
 * The brain. Takes one incoming message (text and/or image), runs the model
 * with tools against the user's saved state, persists the result and returns
 * the reply text. Channel-agnostic: WhatsApp, a CLI and a web UI all call this.
 */

const MAX_TOOL_ROUNDS = 6;
/** How many past messages the model sees. */
const MODEL_HISTORY = 20;
/** How many we keep, so the chat screen can show more scrollback. */
export const STORED_HISTORY = 60;
/** Demo sandboxes expire a week after their last message. */
const DEMO_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface IncomingMessage {
  text?: string;
  /** Data URL (data:image/jpeg;base64,...) or a public https URL. */
  imageUrl?: string;
}

function client(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.PUBLIC_URL ?? "http://localhost:3000",
      "X-Title": "Khana Log",
    },
  });
}

function pickModel(hasImage: boolean): string {
  const text = process.env.TEXT_MODEL || "qwen/qwen3.7-flash";
  const vision = process.env.VISION_MODEL || "qwen/qwen3.7-flash";
  return hasImage ? vision : text;
}

/**
 * OpenRouter falls back to the next model in `models` if the first is rate
 * limited or down. Useful when the primary is a `:free` model.
 */
function modelRouting(primary: string): { model: string; models?: string[] } {
  const fallback = process.env.FALLBACK_MODEL;
  if (!fallback || fallback === primary) return { model: primary };
  return { model: primary, models: [primary, fallback] };
}

function systemPrompt(state: UserState): string {
  const tz = state.profile.timezone;
  const today = dayKey(tz);
  const summary = summarise(state, today);
  const taught = Object.entries(state.foods)
    .map(([n, c]) => `${n}: ${c} kcal`)
    .join(", ");

  return `You are a friendly, concise calorie-tracking assistant inside a small mobile chat app.

Current time for the user: ${localTimeString(tz)} (${today}, timezone ${tz ?? "not set, assuming Asia/Karachi"}).

USER PROFILE: ${JSON.stringify(state.profile)}
DAILY GOAL: ${state.goal.dailyCalories ? `${state.goal.dailyCalories} kcal (${state.goal.source})` : "not set yet"}
TAUGHT FOODS (always use these values when the user mentions them): ${taught || "none yet"}
TODAY SO FAR: eaten ${summary.eaten} kcal, burned ${summary.burnedExercise + summary.burnedSteps} kcal (${summary.steps} steps), net ${summary.net}${summary.remaining !== null ? `, remaining ${summary.remaining}` : ""}.

HOW TO BEHAVE
- When the user mentions eating or drinking something, call log_food with a realistic calorie estimate for a typical South Asian / general portion. Chai with milk and sugar ≈ 120 kcal per cup, black coffee ≈ 5, coffee with milk and sugar ≈ 80, a roti ≈ 100, a plate of biryani ≈ 550. Don't ask for confirmation on everyday items; just log and tell them the number so they can correct you.
- When the user sends a food PHOTO: identify what it is and estimate the portion. If you can tell reasonably well, log it. If you genuinely can't (unclear dish, hidden portion, could be cooked in oil/ghee or not), do NOT log yet: say what you think you see and ask ONE short question. When they answer, log it.
- Log corrections: if they say "actually that was 2 cups" use delete_last_entry then log_food again.
- Use set_profile when they tell you weight, height, age, sex, activity, goal (lose/maintain/gain) or where they live (timezone). If profile fields are missing for the calorie calculation, ask for them once, briefly.
- Use set_goal only when they explicitly state a calorie target themselves.
- Use teach_food when they say what THEIR version of a food is worth ("my chai is 90 cal").
- Never do calorie arithmetic yourself; the tool results contain the totals. Quote them.
- After logging, always end with the running total in this format: "Today: 840 / 1,800 kcal" (or "Today: 840 kcal" if no goal is set).
- Keep replies short (1-3 lines). No markdown headings, no bullet lists unless the user asks for a full summary. Plain text. Never use emojis.
- If the user asks something unrelated to food, health, or their log, answer briefly and steer back.`;
}

function toOpenAIHistory(state: UserState): ChatCompletionMessageParam[] {
  return state.history.slice(-MODEL_HISTORY).map((m) => ({ role: m.role, content: m.content }));
}

function buildUserContent(msg: IncomingMessage): string | ChatCompletionContentPart[] {
  if (!msg.imageUrl) return msg.text ?? "";
  const parts: ChatCompletionContentPart[] = [];
  parts.push({ type: "text", text: msg.text?.trim() || "What is this and roughly how many calories? Log it if you can tell." });
  parts.push({ type: "image_url", image_url: { url: msg.imageUrl } });
  return parts;
}

interface ToolOutcome {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

/**
 * Deterministic reply built from what the tools actually did. Used only when
 * the model returns nothing, so the user still sees what was logged and the
 * running total instead of a generic acknowledgement.
 */
/** "Today: 480 / 1,334 kcal, 854 left." from the current state. */
function todayLine(state: UserState): string {
  const today = summarise(state, dayKey(state.profile.timezone));
  if (!today.goal) return `Today: ${fmtNum(today.eaten)} kcal.`;
  const rem = today.remaining ?? 0;
  return `Today: ${fmtNum(today.eaten)} / ${fmtNum(today.goal)} kcal, ${rem >= 0 ? `${fmtNum(rem)} left` : `${fmtNum(-rem)} over`}.`;
}

function fallbackReply(state: UserState, outcomes: ToolOutcome[], sideText: string): string {
  const total = todayLine(state);

  const parts: string[] = [];
  for (const o of outcomes) {
    const r = o.result as Record<string, unknown> | null;
    switch (o.tool) {
      case "log_food": {
        const l = r?.logged as { name?: string; calories?: number } | undefined;
        if (l) parts.push(`Logged ${l.name} (${fmtNum(l.calories ?? 0)} kcal)`);
        break;
      }
      case "log_burned": {
        const l = r?.logged as { activity?: string; calories?: number } | undefined;
        if (l) parts.push(`Logged ${l.activity}, ${fmtNum(l.calories ?? 0)} kcal burned`);
        break;
      }
      case "set_steps": {
        if (r) parts.push(`${fmtNum(Number(r.steps))} steps, about ${fmtNum(Number(r.caloriesFromSteps))} kcal burned`);
        break;
      }
      case "set_profile": {
        const goal = r?.dailyGoal as number | null | undefined;
        parts.push(goal ? `Profile saved. Daily target: ${fmtNum(goal)} kcal` : "Profile saved");
        break;
      }
      case "set_goal":
        parts.push(`Daily target set to ${fmtNum(Number(r?.dailyGoal))} kcal`);
        break;
      case "teach_food": {
        const t = r?.taught as { name?: string; calories?: number } | undefined;
        if (t) parts.push(`Remembered: ${t.name} = ${fmtNum(t.calories ?? 0)} kcal`);
        break;
      }
      case "delete_last_entry": {
        const removed = r?.removed as { name?: string; activity?: string } | null | undefined;
        parts.push(removed ? `Removed ${removed.name ?? removed.activity}` : "Nothing to remove");
        break;
      }
    }
  }

  if (parts.length === 0) return sideText || `${total}`;
  return `${parts.join(". ")}. ${total}`;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export class QuotaExceededError extends Error {
  constructor(public limit: number) {
    super(`Daily message limit of ${limit} reached`);
  }
}

export interface HandleOptions {
  /** Max messages per day for this user (demo sandboxes). Unlimited if omitted. */
  dailyLimit?: number;
}

export async function handleMessage(
  userId: string,
  msg: IncomingMessage,
  opts: HandleOptions = {},
): Promise<string> {
  const store = getStore();
  const state = await store.load(userId);

  if (opts.dailyLimit !== undefined) {
    const today = dayKey(state.profile.timezone);
    const used = state.usage?.date === today ? state.usage.count : 0;
    if (used >= opts.dailyLimit) throw new QuotaExceededError(opts.dailyLimit);
    state.usage = { date: today, count: used + 1 };
  }

  const ai = client();
  const model = pickModel(Boolean(msg.imageUrl));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(state) },
    ...toOpenAIHistory(state),
    { role: "user", content: buildUserContent(msg) },
  ];

  let reply = "";
  // Text the model sent in the same turn as its tool calls, and what the tools did,
  // so we can still answer with numbers if the model goes quiet afterwards.
  let sideText = "";
  const outcomes: ToolOutcome[] = [];
  let usedTools = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await ai.chat.completions.create({
      ...modelRouting(model),
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
      temperature: 0.3,
      // Replies are a few lines. Without a cap OpenRouter reserves the model's
      // full output limit against the key's credit limit and rejects the call.
      max_tokens: 600,
    });

    let choice = res.choices[0];
    // An empty answer with no tool calls means the model gave up (or burned its
    // budget on hidden reasoning). Try the fallback model once before moving on.
    if (!choice?.message?.content?.trim() && !(choice?.message?.tool_calls?.length) && process.env.FALLBACK_MODEL && process.env.FALLBACK_MODEL !== model) {
      const retry = await ai.chat.completions.create({
        model: process.env.FALLBACK_MODEL,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
        temperature: 0.3,
        max_tokens: 600,
      });
      choice = retry.choices[0] ?? choice;
    }
    const assistant = choice.message;
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      reply = (assistant.content ?? "").trim();
      break;
    }
    if (assistant.content?.trim()) sideText = assistant.content.trim();

    for (const call of calls) {
      if (call.type !== "function") continue;
      usedTools = true;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const result = runTool(state, call.function.name, args);
      outcomes.push({ tool: call.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // The model called tools but never wrote a reply: ask once more, without tools.
  if (!reply && usedTools) {
    try {
      const res = await ai.chat.completions.create({
        ...modelRouting(model),
        messages: [...messages, { role: "user", content: "Reply to me now in 1-2 plain sentences using the tool results above. Include today's total." }],
        temperature: 0.3,
        max_tokens: 300,
      });
      reply = (res.choices[0]?.message.content ?? "").trim();
    } catch (err) {
      console.warn("[agent] follow-up reply failed", err);
    }
  }

  if (!reply) reply = fallbackReply(state, outcomes, sideText);

  // Whenever the day changed, make sure the running total is in the reply even
  // if the model forgot it. Users shouldn't have to ask "and how much is that?".
  const changedDay = outcomes.some((o) => ["log_food", "log_burned", "set_steps", "delete_last_entry"].includes(o.tool));
  if (changedDay && !/today\s*:/i.test(reply) && !/\d[\d,]*\s*\/\s*\d[\d,]*\s*kcal/i.test(reply)) {
    reply = `${reply}\n\n${todayLine(state)}`;
  }

  const now = new Date().toISOString();
  state.history.push(
    { role: "user", content: msg.imageUrl ? `[photo] ${msg.text ?? ""}`.trim() : msg.text ?? "", time: now },
    { role: "assistant", content: reply, time: now },
  );
  state.history = state.history.slice(-STORED_HISTORY);

  await store.save(userId, state, userId.startsWith("demo:") ? DEMO_TTL_SECONDS : undefined);
  return reply;
}
