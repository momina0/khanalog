/**
 * Scripted end-to-end run against the real model, no WhatsApp needed.
 *
 *   npx tsx scripts/smoke.ts
 *
 * Uses a throwaway user id so it never touches your real log.
 */
import { config } from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { handleMessage } from "../lib/agent";

config({ path: ".env.local", quiet: true });

const USER = "smoke-test-user";
const PHOTO_ONLY = process.argv.includes("--photo-only");
/** Any food photo you drop in the project root as test-food.jpg / .png / .webp. */
const PHOTO = ["test-food.jpg", "test-food.jpeg", "test-food.png", "test-food.webp"];

/** Mirror production: the webhook sends photos as base64 data URLs, not remote links. */
async function photoAsDataUrl(): Promise<string | undefined> {
  for (const name of PHOTO) {
    try {
      const buf = await fs.readFile(path.join(process.cwd(), name));
      const mime = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const script: { text?: string; imageUrl?: string }[] = [
  { text: "hi, I'm 62kg, 160cm, 25 years old, female, lightly active and I want to lose weight. I live in Karachi." },
  { text: "I drank chai" },
  { text: "my chai is actually 90 calories, remember that" },
  { text: "had another chai and 2 parathas" },
  { text: "walked 6000 steps" },
  { text: "actually remove the parathas, I only had one" },
  { text: "what have I eaten today?" },
  { imageUrl: "photo" },
  { text: "it was about half a plate" },
  { text: "set my goal to 1500" },
  { text: "how am I doing?" },
];

async function main() {
  const photo = await photoAsDataUrl();
  if (!photo) console.log("(no test-food.jpg in project root; skipping photo steps)\n");
  const steps = (PHOTO_ONLY ? [{ imageUrl: "photo" }, { text: "it was about half a plate" }] : script)
    .map((m) => (m.imageUrl ? { ...m, imageUrl: photo } : m))
    .filter((m) => m.text || m.imageUrl);
  // Start clean on a full run; keep the existing log for a photo-only run.
  if (!PHOTO_ONLY) {
    await fs.rm(path.join(process.cwd(), ".data", `${USER}.json`), { force: true });
    if (process.env.DATABASE_URL) {
      const { neon } = await import("@neondatabase/serverless");
      await neon(process.env.DATABASE_URL).query("DELETE FROM users WHERE id = $1", [USER]);
    }
  }

  const t0 = Date.now();
  for (const msg of steps) {
    const label = msg.imageUrl ? "[photo]" : msg.text;
    console.log(`\nyou> ${label}`);
    const start = Date.now();
    try {
      const reply = await handleMessage(USER, msg);
      console.log(`bot> ${reply}   (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.error("ERROR:", err instanceof Error ? err.message : err);
    }
  }

  const { getStore } = await import("../lib/store");
  const saved = await getStore().load(USER);
  console.log("\n--- saved state ---");
  console.log(JSON.stringify({ profile: saved.profile, goal: saved.goal, foods: saved.foods, days: saved.days }, null, 2));
  console.log(`\nTotal: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
