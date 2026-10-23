# Khana Log

A calorie-tracking assistant you just talk to. Installable on your phone as a web app.

> "had chai and 2 parathas" → *Logged chai (120) and 2 parathas (~500). Today: 620 / 1,400 kcal*

- **Chat-first**: natural-language logging for food, workouts and steps. Undo with "actually, remove that".
- **Food photos**: a vision model identifies the dish and portion, and asks one question if unsure.
- **Accounts** via Clerk (email or Google); every user's data lives in Postgres.
- **Daily target** calculated from weight / height / age / sex / activity (Mifflin-St Jeor), or set manually.
- **Today view**: progress ring, 7-day chart, swipe-to-delete log, steps.
- Optional rate-limited **demo sandbox** for visitors, no account needed, auto-deleted after a week.

The model never does arithmetic. Every log, goal and total is a deterministic tool call in
[`lib/tools.ts`](lib/tools.ts); the model only decides which tool to call and writes the reply.

## How it works

```
Phone (PWA) ⇄ Next.js on Vercel ⇄ OpenRouter (tool calling + vision)
                  │        │
              Clerk auth   Neon Postgres (users, days, entries, messages)
```

| File | Role |
|---|---|
| `lib/agent.ts` | Builds the prompt, runs the tool loop, saves history, enforces demo quota |
| `lib/tools.ts` | `log_food`, `log_burned`, `set_steps`, `set_profile`, `set_goal`, `teach_food`, `delete_last_entry`, `get_summary` |
| `lib/calories.ts` | BMR / maintenance / target math |
| `lib/store.ts` | Postgres (Neon) in prod; Upstash Redis or local JSON as fallbacks |
| `lib/auth.ts` | Clerk session for users, signed cookie for demo sandboxes |
| `db/schema.sql` | Tables: `users`, `days`, `entries`, `messages` |
| `app/api/*` | `chat`, `state`, `entries`, `steps`, `profile`, `auth/demo`, `auth/logout` |
| `components/*` | `Chat`, `TodayView`, `WeekChart`, `ProfileForm`, `Landing`, `DemoButton`, `BottomNav` |

## Run locally

```bash
npm install
cp .env.example .env.local      # fill in OpenRouter, Clerk and DATABASE_URL
npm run db:push                 # create the tables (once per database)
npm run dev                     # http://localhost:3000
npm test                        # calorie math, tools, and the Postgres store (in-process PGlite)
npm run chat                    # terminal chat against the agent, no browser needed
```

Without `DATABASE_URL`, data falls back to `.data/*.json` so the terminal chat works with just an OpenRouter key.

## Deploy (Vercel CLI, no GitHub needed)

```bash
npm i -g vercel
vercel login
vercel                          # first deploy, creates the project
```

Then in the Vercel dashboard for the project:

1. **Storage → Create Database → Neon**. This sets `DATABASE_URL` for you.
2. **Settings → Environment Variables**: add the OpenRouter, Clerk and demo variables from `.env.example`.
3. Locally, put the same `DATABASE_URL` in `.env.local` and run `npm run db:push` once.
4. `vercel --prod`.
5. In Clerk, add your Vercel URL to the app's allowed origins when you go to production keys.

On your phone, open the URL in the browser and choose **Add to Home Screen**.

## Notes

- Text messages go to `TEXT_MODEL`, photos to `VISION_MODEL`, and `FALLBACK_MODEL` takes over if the
  primary is down or returns an empty reply. Defaults are DeepSeek V4.1 Flash with Qwen 3.7 Flash as
  fallback, about $0.0003 per message; all swappable via env.
- If the model calls tools but writes no reply, the app asks once more and otherwise composes the
  reply itself from what the tools did, so you always see what was logged and the running total.
- The store loads the last 120 days into memory per request; older days stay in Postgres untouched.
