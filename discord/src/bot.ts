// Discord bridge for an enhancement-product Smithers worker.
//
//   /concept      → modal brief → thread → drop refs → ▶ Start → run
//   /concept-json → paste/attach a full concept (or {concepts:[…]}) JSON
//   #qc thread    → prompt QC + image QC (Approve / Deny+note buttons),
//                   and (manual backend) the generate handoff: drop a PNG
//   #status       → run lifecycle one-liners
//   #outputs      → accepted final images
//
// The bot polls each active run's control plane for pending gates / human
// requests and mirrors them into the concept's thread. All decisions go back
// through the Smithers CLI/HTTP (see smithers.ts).
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType, AttachmentBuilder,
  PermissionFlagsBits,
  type Message, type TextChannel, type ThreadChannel,
  type ChatInputCommandInteraction, type ModalSubmitInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { mkdir, writeFile, readdir, readFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config";
import { store, type RunRow } from "./store";
import * as sm from "./smithers";
import { cid, qcMessage, denyNoteModal, editPromptModal, conceptModal, startRow, stopDiscardRow, intakeCard, reqModal, expandedCard, directionComponents } from "./ui";
import { validateConcept, lines, type Concept } from "../../.smithers/shared/concept-schema";
import { expandConcept, pitchDirections, slugify, safeSlug } from "./expand";

const IMG_EXT = /\.(png|jpe?g|webp)$/i;
const isImage = (ct: string | null, name: string, size: number) =>
  (!!ct && ct.startsWith("image/")) || IMG_EXT.test(name) ? size >= 1000 && size <= 25_000_000 : false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// ── helpers ──────────────────────────────────────────────────────────────────
// Download an IMAGE. Throws instead of writing junk: Discord CDN links expire,
// and an expired one returns 200/404 with a text body ("This content is no
// longer available.") that, saved as ref_0.png, poisons every generation
// attempt with an OpenAI `invalid_image_file` 400.
async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching attachment (expired link?)`);
  const ct = res.headers.get("content-type");
  const buf = Buffer.from(await res.arrayBuffer());
  if ((ct && !ct.startsWith("image/")) || buf.length < 1000)
    throw new Error(`attachment is not an image (${ct ?? "unknown type"}, ${buf.length} bytes — expired link?)`);
  await mkdir(resolve(dest, ".."), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

// Newest candidate image for a concept (to attach to the image-QC card).
async function latestCandidate(slug: string): Promise<AttachmentBuilder[]> {
  const dir = resolve(config.projectRoot, `outputs/${slug}/candidates`);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  return files.length ? [new AttachmentBuilder(resolve(dir, files[files.length - 1]))] : [];
}

// The run's effective final prompt: the human's ✏️ Edit / Use-B pick when one
// exists (the workflow treats that file as authoritative), else the latest
// composed primary.
async function finalPromptFor(r: { runId: string; slug: string }): Promise<string | null> {
  try {
    const p = resolve(config.projectRoot, `outputs/${r.slug}/.edited-${r.runId}.txt`);
    if (existsSync(p)) {
      const t = (await readFile(p, "utf8")).trim();
      if (t) return t;
    }
  } catch {}
  return sm.composedPrompt(r.runId);
}

// Image for the image-QC card: the judge's best-of-n pick when available (that
// is the image the approve/deny decision applies to), else the newest candidate.
async function candidateAttachment(runId: string, slug: string): Promise<AttachmentBuilder[]> {
  const best = sm.judgeBest(runId);
  if (best) {
    const p = resolve(config.projectRoot, best); // absolute paths pass through
    if (existsSync(p)) return [new AttachmentBuilder(p)];
  }
  return latestCandidate(slug);
}

async function getThread(threadId: string): Promise<ThreadChannel | null> {
  const ch = await client.channels.fetch(threadId).catch(() => null);
  return ch && ch.isThread() ? (ch as ThreadChannel) : null;
}
async function postStatus(text: string) {
  const ch = (await client.channels.fetch(config.channels.status).catch(() => null)) as TextChannel | null;
  await ch?.send(text).catch(() => {});
}

// Strip the buttons off a previously-posted card (keyed in the store) once its
// action no longer applies — e.g. the "skip generation" button after the PNG
// was dropped. No-op if we never tracked it.
async function clearCardButtons(key: string) {
  const ref = store.takeMsgRef(key);
  if (!ref) return;
  const ch = await client.channels.fetch(ref.channelId).catch(() => null);
  if (!ch || !("messages" in ch)) return;
  const m = await (ch as TextChannel | ThreadChannel).messages.fetch(ref.messageId).catch(() => null);
  await m?.edit({ components: [] }).catch(() => {});
}

// Public #requests feed: a neutral, persistent acknowledgement per request so
// the channel shows life and the requester sees progress — WITHOUT exposing the
// idea text or any internals. Edited in place as the request changes state.
async function setPublicRequest(token: string, content: string) {
  const ref = store.takeMsgRef(`pubreq:${token}`);
  if (!ref) return;
  const ch = await client.channels.fetch(ref.channelId).catch(() => null);
  if (!ch || !("messages" in ch)) return;
  const m = await (ch as TextChannel | ThreadChannel).messages.fetch(ref.messageId).catch(() => null);
  await m?.edit({ content }).catch(() => {});
}

// A persistent, copy-friendly echo of the entered brief so it can be re-entered
// if a run needs to be restarted. Blank fields are shown as "(invented)" since
// compose fills them from the theme.
function briefSummary(c: {
  slug: string; gender: string; name: string; theme: string;
  mainTagline: string | null; copyLines: string[]; extraInstructions: string | null;
}): string {
  const copy = c.copyLines.length ? c.copyLines.join("\n") : "(invented)";
  return [
    "📋 **Brief** — copy this if you ever need to re-enter it:",
    "```",
    `slug:    ${c.slug}`,
    `gender:  ${c.gender}`,
    `name:    ${c.name}`,
    `theme:   ${c.theme}`,
    `tagline: ${c.mainTagline ?? "(invented)"}`,
    `copy lines:`,
    copy,
    `extra:   ${c.extraInstructions ?? "(none)"}`,
    "```",
  ].join("\n");
}

// Admins = members with the configured role (or Administrator perm). The role is
// required (config.req), and this denies by default — there is no un-gated mode.
async function isAdmin(i: ChatInputCommandInteraction | ButtonInteraction): Promise<boolean> {
  if (!config.adminRoleId) return false;
  const member = await i.guild?.members.fetch(i.user.id).catch(() => null);
  if (!member) return false;
  return member.roles.cache.has(config.adminRoleId) || member.permissions.has(PermissionFlagsBits.Administrator);
}

function runInput(concept: Concept) {
  return {
    concepts: [concept],
    backend: config.backend,
    promptQc: config.promptQc,
    imageQc: config.imageQc,
    maxAttempts: config.maxAttempts,
    composeModel: config.composeModel,
    composeFirstModel: config.composeFirstModel,
    judgeModel: config.judgeModel,
    toolModel: config.toolModel,
  };
}

// Public-facing label for a run: the product name (prettier than the slug), read
// from the stored input. Falls back to the slug if the name isn't available.
function displayName(r: { slug: string; inputJson: string | null }): string {
  try {
    const c = JSON.parse(r.inputJson ?? "{}")?.concepts?.[0];
    if (c?.name) return String(c.name);
  } catch {}
  return r.slug;
}

// Derive a unique output folder slug from a product name (admins no longer type
// it). Appends a short suffix if that slug is already taken by another run.
function uniqueSlug(name: string): string {
  const base = slugify(name);
  return store.runBySlug(base) ? `${base}_${Date.now().toString(36).slice(-4)}` : base;
}

// Kick off the actual smithers run in a thread + record the mapping. Every
// start path (Start button, direction pick, /concept-json, requests, /rerun)
// ends here.
async function beginRun(concept: Concept, thread: ThreadChannel, requesterId: string | null): Promise<string> {
  const runId = `${concept.slug}-${Date.now().toString(36)}`;
  const inputJson = JSON.stringify(runInput(concept));
  sm.startRun(runId, inputJson);
  store.addRun({ runId, slug: concept.slug, threadId: thread.id, port: 0, requesterId, inputJson });
  await thread.send(
    `🚀 **${concept.name}** started (\`${runId}\`, backend=\`${config.backend}\`).\n` +
      `I'll post prompt QC here, then ${config.backend === "manual" ? "ask you to drop the generated PNG" : "generate and post the image"}, then image QC.`,
  );
  await postStatus(`🚀 \`${concept.slug}\` started — ${concept.name}`);
  return runId;
}

// Pre-run direction pick: author N SHORT artwork pitches and post them inline
// with [1..N] + skip buttons; the run starts on click (the pick lands in the
// concept's `artwork` field as a weighted seed for compose). Returns false —
// meaning "start the run immediately instead" — when the knob is off, the
// brief already directs the artwork, or pitch authoring fails; the pick is a
// bonus, never a blocker.
async function offerDirections(concept: Concept, thread: ThreadChannel, requesterId: string | null): Promise<boolean> {
  if (config.directions < 2 || concept.artwork) return false;
  const note = await thread.send("✨ Authoring direction options…").catch(() => null);
  if (!note) return false;
  const pitches = await pitchDirections(concept, config.directions);
  if (pitches.length < 2) {
    await note.delete().catch(() => {});
    return false;
  }
  const token = `dir:${concept.slug}:${Date.now().toString(36)}`;
  store.saveIntake(token, { concept, pitches, requesterId, threadId: thread.id });
  const body = pitches.map((p, n) => `**${n + 1}.** ${p}`).join("\n\n");
  await note.edit({
    content: `🎨 **Pick direction(s) for the artwork** — tick more than one for a run per direction, or let compose decide:\n\n${body}`.slice(0, 1990),
    components: directionComponents(token, pitches),
  }).catch(() => {});
  return true;
}

// A sibling slug for extra direction picks (`<slug>_d2`, …). Trims the base so
// the suffix survives the 40-char cap, and bumps to a time suffix on collision.
function directionSlug(base: string, dirNum: number): string {
  const s = safeSlug(`${base.slice(0, 35)}_d${dirNum}`);
  return store.runBySlug(s) ? safeSlug(`${base.slice(0, 30)}_d${dirNum}_${Date.now().toString(36).slice(-4)}`) : s;
}

// Create the thread and either offer the direction pick or start right away.
async function launch(concept: Concept, qc: TextChannel, requesterId: string | null = null): Promise<string> {
  // Harden the slug before it touches the filesystem + the generate agent's shell
  // command. Single chokepoint: every launch path (/concept, /concept-json, and
  // approved requests) funnels through here.
  concept.slug = safeSlug(concept.slug);
  const thread = await qc.threads.create({
    name: `${concept.slug}`.slice(0, 90),
    autoArchiveDuration: 1440,
    type: ChannelType.PublicThread,
    reason: `Concept run: ${concept.name}`,
  });
  if (await offerDirections(concept, thread, requesterId)) return `<#${thread.id}> (pick a direction there to start)`;
  return beginRun(concept, thread, requesterId);
}

// What we stash for an approved request between intake and launch.
type ReqStash = {
  requesterId: string;
  idea: string;
  suggestedName: string | null;
  gender: Concept["gender"];
  refUrls: string[];
  refPaths?: string[]; // local copies saved at intake time (URLs expire; these don't)
  expanded?: { name: string; theme: string; mainTagline: string; copyLines: string[]; extraInstructions: string };
};

// Shared launch path for an approved request (both "Launch as-is" and the edited
// modal land here): derive a slug, pull in the requester's refs, validate, run,
// then flip the public feed + strip the intake card + DM the requester.
async function launchRequest(
  token: string,
  stash: ReqStash,
  fields: { name: string; theme: string; mainTagline: string; copyLines: string[]; extraInstructions: string },
  byId: string,
): Promise<{ ok: true; runId: string; warning?: string } | { ok: false; errors: string[] }> {
  const slug = uniqueSlug(fields.name);
  const refDir = `outputs/${slug}/ref_images`;
  // Prefer the files saved at intake time (CDN URLs expire); re-download only for
  // stashes from before refPaths existed. Count only successes so refImages never
  // claims files that aren't actually on disk.
  let n = 0;
  const refFails: string[] = [];
  const fromDisk = !!stash.refPaths?.length;
  for (const src of fromDisk ? stash.refPaths! : stash.refUrls) {
    const dest = resolve(config.projectRoot, refDir, `ref_${n}.png`);
    try {
      if (fromDisk) {
        await mkdir(resolve(dest, ".."), { recursive: true });
        await copyFile(src, dest);
      } else await download(src, dest);
      n++;
    } catch (e) { refFails.push(e instanceof Error ? e.message : String(e)); }
  }
  const concept = {
    slug, gender: stash.gender,
    name: fields.name,
    theme: fields.theme,
    mainTagline: fields.mainTagline || null,
    copyLines: fields.copyLines,
    extraInstructions: fields.extraInstructions || null,
    refImages: n > 0 ? [refDir] : [],
  };
  const v = validateConcept(concept);
  if (!v.ok) return { ok: false, errors: v.errors };
  const qc = (await client.channels.fetch(config.channels.qc)) as TextChannel;
  const runId = await launch(v.value, qc, stash.requesterId);
  await setPublicRequest(token, `✅ **Request** from <@${stash.requesterId}> — accepted, in production!`);
  await clearCardButtons(`reqcard:${token}`);
  const u = await client.users.fetch(stash.requesterId).catch(() => null);
  await u?.send(`✅ Your request "${concept.name}" was approved and is being created — I'll send a gallery link when it's ready.`).catch(() => {});
  if (fromDisk) await rm(resolve(stash.refPaths![0], ".."), { recursive: true, force: true }).catch(() => {});
  return {
    ok: true, runId,
    warning: refFails.length ? `⚠️ ${refFails.length} reference image(s) skipped (${refFails[0]}) — launched without them.` : undefined,
  };
}

// Save every HUMAN-posted image in the thread as the concept's reference set.
// Bot messages are skipped — in a run's thread the bot posts QC candidates and
// final outputs, which must never be swept in as references (/rerun reuses this
// on old threads, not just fresh ▶ Start ones).
async function collectRefs(thread: ThreadChannel, slug: string): Promise<string[]> {
  const dir = `outputs/${slug}/ref_images`;
  const msgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  let n = 0;
  if (msgs) {
    for (const m of msgs.values()) {
      if (m.author.bot) continue;
      for (const a of m.attachments.values()) {
        if (isImage(a.contentType, a.name ?? "", a.size)) {
          const ext = (a.name?.match(IMG_EXT)?.[0] ?? ".png").toLowerCase();
          try {
            await download(a.url, resolve(config.projectRoot, dir, `ref_${n}${ext}`));
            n++;
          } catch (e) { console.error("collectRefs skip", a.name, e); }
        }
      }
    }
  }
  return n > 0 ? [dir] : [];
}

// ── slash commands ───────────────────────────────────────────────────────────
async function onCommand(i: ChatInputCommandInteraction) {
  // Outsider-facing: submit a loose idea → admin-only intake queue. No internals.
  if (i.commandName === "request") {
    if (config.channels.requests && i.channelId !== config.channels.requests) {
      return void i.reply({ ephemeral: true, content: `Please use <#${config.channels.requests}>.` });
    }
    if (!config.channels.intake) return void i.reply({ ephemeral: true, content: "Requests aren't enabled on this worker." });
    await i.deferReply({ ephemeral: true }); // ack before the channel fetch + card/ack sends
    const idea = i.options.getString("idea", true);
    const suggestedName = i.options.getString("name");
    const gender = i.options.getString("gender") ?? "male";
    const refAtts = ["image1", "image2", "image3"]
      .map((k) => i.options.getAttachment(k))
      .filter((a): a is NonNullable<typeof a> => !!a && isImage(a.contentType, a.name ?? "", a.size));
    const token = `req:${i.user.id}:${Date.now().toString(36)}`;
    // Save the refs NOW, while the CDN links are fresh. They're signed and expire,
    // and approval can come days later — an expired link once poisoned an entire
    // run ("This content is no longer available." saved as ref_0.png → OpenAI 400
    // on all 9 attempts). launchRequest copies these files instead of re-fetching.
    const refPaths: string[] = [];
    for (const a of refAtts) {
      const dest = resolve(config.projectRoot, `outputs/.intake/${token.replace(/[^a-zA-Z0-9_-]/g, "_")}/ref_${refPaths.length}.png`);
      try { refPaths.push(await download(a.url, dest)); } catch (e) { console.error("intake ref download failed", e); }
    }
    store.saveIntake(token, { requesterId: i.user.id, idea, suggestedName, gender, refUrls: refAtts.map((a) => a.url), refPaths });
    const intake = (await client.channels.fetch(config.channels.intake)) as TextChannel;
    await intake.send(intakeCard({
      token, requesterId: i.user.id, requesterTag: i.user.username,
      idea, suggestedName, gender, refCount: refPaths.length,
    }));
    // Persistent, neutral public ack (no idea text) so the channel shows life
    // and the requester can see their request move through review.
    const pub = await (i.channel as TextChannel | null)
      ?.send(`📥 **New request** from <@${i.user.id}> — 🕒 under review.`)
      .catch(() => null);
    if (pub) store.saveMsgRef(`pubreq:${token}`, pub.channelId, pub.id);
    return void i.editReply("✅ Request submitted. You'll hear back once it's reviewed.");
  }

  // Everything below is admin-only (the real workflow + run control).
  if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });

  if (i.commandName === "concept") {
    const slug = i.options.getString("slug", true).trim();
    const gender = (i.options.getString("gender") ?? "male") as Concept["gender"];
    const token = `${slug}:${Date.now().toString(36)}`;
    store.saveIntake(token, { slug, gender });
    await i.showModal(conceptModal(token));
    return;
  }

  if (i.commandName === "concept-json") {
    await i.deferReply({ ephemeral: true });
    let text = i.options.getString("json") ?? "";
    const file = i.options.getAttachment("file");
    if (file) text = await (await fetch(file.url)).text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return void i.editReply("❌ Not valid JSON."); }
    const concepts: unknown[] = Array.isArray(parsed?.concepts) ? parsed.concepts : [parsed];
    const qc = (await client.channels.fetch(config.channels.qc)) as TextChannel;
    const started: string[] = [];
    for (const raw of concepts) {
      const v = validateConcept(raw);
      if (!v.ok) { await i.followUp({ ephemeral: true, content: `❌ \`${(raw as any)?.slug ?? "?"}\`:\n• ${v.errors.join("\n• ")}` }); continue; }
      await launch(v.value, qc);
      started.push(v.value.slug);
    }
    await i.editReply(started.length ? `✅ Started: ${started.join(", ")}` : "Nothing started.");
    return;
  }

  if (i.commandName === "status") {
    const rows = store.activeRuns();
    if (!rows.length) return void i.reply({ ephemeral: true, content: "No active runs." });
    const lines = rows.map((r) => {
      const last = sm.lastActivityMs(r.runId);
      const idleMin = last ? Math.round((Date.now() - last) / 60_000) : null;
      const stalled = sm.openGates(r.runId).length === 0 && last > 0 && Date.now() - last > config.stallMin * 60_000;
      return `• **${displayName(r)}** \`${r.runId}\`\n   ${stageLabel(r.runId)} · idle ${idleMin ?? "?"}m${stalled ? " ⚠️ **stalled**" : ""}`;
    });
    await i.reply({ ephemeral: true, content: lines.join("\n").slice(0, 1900) });
    return;
  }

  if (i.commandName === "cancel") {
    const r = store.runByThread(i.channelId);
    if (!r) return void i.reply({ ephemeral: true, content: "Run this inside a concept thread." });
    await i.deferReply(); // ack before the slow smithers cancel
    await sm.cancel(r.runId); store.setRunStatus(r.runId, "cancelled");
    await i.editReply(`🛑 Cancelled \`${r.slug}\`.`);
  }

  // Admin run controls. `run` accepts a runId or slug; omitted = the run for the
  // current thread. stop = soft (reopenable); discard = hard (forgotten).
  if (i.commandName === "stop" || i.commandName === "discard" || i.commandName === "reopen") {
    if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });
    const arg = i.options.getString("run")?.trim();
    const r = arg ? (store.runById(arg) ?? store.runBySlug(arg)) : store.runByThread(i.channelId);
    if (!r) {
      if (i.commandName === "reopen") {
        const shelved = store.shelvedRuns();
        const list = shelved.length ? shelved.map((s) => `• \`${s.runId}\` (${s.slug})`).join("\n") : "(none)";
        return void i.reply({ ephemeral: true, content: `Run not found. Shelved runs:\n${list}` });
      }
      return void i.reply({ ephemeral: true, content: "Run not found — pass a runId/slug or use this in the run's thread." });
    }
    await i.deferReply({ ephemeral: true });
    if (i.commandName === "stop") { await softStop(r.runId, i.user.id); return void i.editReply(`⏸ Stopped \`${r.runId}\` — reopen with \`/reopen ${r.runId}\`.`); }
    if (i.commandName === "discard") { await hardDiscard(r.runId, i.user.id); return void i.editReply(`🗑 Discarded \`${r.runId}\` — forgotten.`); }
    const ok = await reopenRun(r.runId, i.user.id);
    return void i.editReply(ok ? `🔓 Reopened \`${r.runId}\` — resuming to its gate.` : `Couldn't reopen \`${r.runId}\` (no saved input).`);
  }

  // Re-run a finished/failed run as a FRESH run, keeping the original requester
  // so they still get their completion DM (a reopen just replays the dead run).
  if (i.commandName === "rerun") {
    if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });
    const arg = i.options.getString("run")?.trim();
    const r = arg ? (store.runById(arg) ?? store.runBySlug(arg)) : store.runByThread(i.channelId);
    if (!r) return void i.reply({ ephemeral: true, content: "Run not found — pass a runId/slug or use this in the run's thread." });
    await i.deferReply({ ephemeral: true });
    let concept: Concept | null = null;
    try { concept = JSON.parse(r.inputJson ?? "{}")?.concepts?.[0] ?? null; } catch {}
    if (!concept) return void i.editReply("Couldn't read that run's concept — nothing to re-run.");
    // Fresh refs on demand: when /rerun is used inside a thread, sweep it for
    // human-dropped images first — drop a new ref, then /rerun. Nothing dropped →
    // keep the concept's existing ref dir (files on disk don't expire).
    let refNote = "";
    if (i.channel?.isThread()) {
      const swept = await collectRefs(i.channel as ThreadChannel, concept.slug);
      if (swept.length) { concept.refImages = swept; refNote = " · refs refreshed from this thread"; }
    }
    const qc = (await client.channels.fetch(config.channels.qc)) as TextChannel;
    const runId = await launch(concept, qc, r.requesterId); // preserves requesterId → they get notified
    return void i.editReply(`🔁 Re-ran \`${r.slug}\` → ${runId}${r.requesterId ? ` (still credited to <@${r.requesterId}>)` : ""}${refNote}`);
  }
}

// ── stop / discard / reopen ──────────────────────────────────────────────────
async function postToThread(threadId: string | null | undefined, content: string) {
  if (!threadId) return;
  const t = await getThread(threadId);
  await t?.send(content).catch(() => {});
}

// Soft stop: shelve a run (keep its recovery handle) so /reopen can bring it back.
async function softStop(runId: string, byId: string) {
  const r = store.runById(runId);
  if (!r) return;
  store.setRunStatus(runId, "shelved");
  await postToThread(r.threadId, `⏸ **Stopped** by <@${byId}> — state kept. Reopen with \`/reopen ${runId}\`.`);
}

// Hard discard: forget the run on the Discord side (drop its handle + markers)
// and cancel the now-orphaned smithers run. Not recoverable.
async function hardDiscard(runId: string, byId: string) {
  const r = store.runById(runId);
  if (!r) return;
  await sm.cancel(runId).catch(() => {});
  await postToThread(r.threadId, `🗑 **Discarded** by <@${byId}> — no record kept.`);
  store.purgeRun(runId);
}

// Reopen a shelved/stopped run: reactivate tracking, force-resume to its gate,
// and clear stale card markers so the open-gate card re-posts.
async function reopenRun(runId: string, byId: string): Promise<boolean> {
  const r = store.runById(runId);
  if (!r || !r.inputJson) return false;
  store.clearMarks(runId);
  store.setRunStatus(runId, "active");
  sm.reopen(runId, r.inputJson);
  await postToThread(r.threadId, `🔓 **Reopened** by <@${byId}> — resuming…`);
  return true;
}

// ── modal submits ────────────────────────────────────────────────────────────
async function onModal(i: ModalSubmitInteraction) {
  if (i.customId.startsWith("conceptmodal:")) {
    const token = i.customId.split(":").slice(1).join(":");
    const stash = store.takeIntake<{ slug: string; gender: Concept["gender"] }>(token);
    if (!stash) return void i.reply({ ephemeral: true, content: "This brief expired — run /concept again." });
    const concept = {
      slug: stash.slug, gender: stash.gender,
      name: i.fields.getTextInputValue("name"),
      theme: i.fields.getTextInputValue("theme"),
      mainTagline: i.fields.getTextInputValue("mainTagline") || null,
      copyLines: lines(i.fields.getTextInputValue("copyLines")),
      extraInstructions: i.fields.getTextInputValue("extraInstructions") || null,
      refImages: [] as string[],
    };
    // Ack immediately: creating the thread below can exceed Discord's 3s
    // interaction deadline, after which reply() throws and the Start button
    // never gets posted (leaving an unstartable thread). Defer first → 15min.
    await i.deferReply({ ephemeral: true });
    const newToken = `${stash.slug}:${Date.now().toString(36)}`;
    store.saveIntake(newToken, concept);
    const qc = (await client.channels.fetch(config.channels.qc)) as TextChannel;
    const thread = await qc.threads.create({ name: stash.slug.slice(0, 90), autoArchiveDuration: 1440, type: ChannelType.PublicThread });
    await thread.send(briefSummary(concept));
    await thread.send({
      content: `🎬 **${concept.name}** — drag any **reference images** into this thread, then hit **▶ Start**.`,
      components: [startRow(newToken)],
    });
    await i.editReply({ content: `Opened <#${thread.id}>.` });
    return;
  }

  if (i.customId.startsWith("denynote:")) {
    const { runId, iteration, nodeId } = cid.parse(i.customId);
    const note = i.fields.getTextInputValue("note");
    const r = store.runById(runId);
    // Idempotence guard BEFORE any await: another click/submit may already have
    // resolved this gate while the modal was open.
    const dkey = `resolved:${runId}:${iteration}:${nodeId}`;
    if (store.hasSeen(dkey)) return void i.reply({ ephemeral: true, content: "Already decided — this gate was resolved while the note was open." }).catch(() => {});
    if (r) store.mark(dkey);
    // Ack within Discord's 3s window BEFORE the slow smithers deny+resume (a
    // `bunx` cold-start can exceed 3s on a small VPS → "interaction failed").
    await i.deferReply().catch(() => {});
    if (r) {
      await clearCardButtons(`card:${runId}:${iteration}:${nodeId}`);
      await sm.deny(r.runId, nodeId, iteration, r.inputJson ?? "", i.user.username, note);
    }
    await i.editReply(`❌ Denied by <@${i.user.id}> — _${note}_`);
    return;
  }

  // ✏️ Edit-prompt submit: the human's exact text becomes the run's FINAL prompt
  // (written where the workflow reads it) and the gate is approved — no recompose,
  // no re-judge. Straight to image generation from their version.
  if (i.customId.startsWith("editmodal:")) {
    const { runId, iteration, nodeId } = cid.parse(i.customId);
    const edited = i.fields.getTextInputValue("prompt");
    const r = store.runById(runId);
    if (!r) return void i.reply({ ephemeral: true, content: "Unknown run." }).catch(() => {});
    // Idempotence guard BEFORE any await (another click may have resolved the
    // gate while the edit modal was open).
    const ekey = `resolved:${r.runId}:${iteration}:${nodeId}`;
    if (store.hasSeen(ekey)) return void i.reply({ ephemeral: true, content: "Already decided — this gate was resolved while the editor was open." }).catch(() => {});
    store.mark(ekey);
    await i.deferReply().catch(() => {}); // ack before the slow approve+resume
    await clearCardButtons(`card:${runId}:${iteration}:${nodeId}`);
    const dir = resolve(config.projectRoot, `outputs/${r.slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, `.edited-${runId}.txt`), edited, "utf8");
    await sm.approve(r.runId, nodeId, iteration, r.inputJson ?? "", i.user.username);
    await i.editReply(`✏️ Prompt edited by <@${i.user.id}> — generating from your exact version (auto-QC skipped).`);
    return;
  }

  // Admin reviewed/edited the auto-expanded concept → launch it. Slug is
  // auto-derived from the name (no slug field); the rest comes from the modal.
  if (i.customId.startsWith("reqmodal:")) {
    const token = i.customId.split(":").slice(1).join(":");
    const stash = store.takeIntake<ReqStash>(token);
    if (!stash) return void i.reply({ ephemeral: true, content: "This request expired." });
    await i.deferReply({ ephemeral: true });
    const fields = {
      name: i.fields.getTextInputValue("name"),
      theme: i.fields.getTextInputValue("theme"),
      mainTagline: i.fields.getTextInputValue("mainTagline") || "",
      copyLines: lines(i.fields.getTextInputValue("copyLines")),
      extraInstructions: i.fields.getTextInputValue("extraInstructions") || "",
    };
    const res = await launchRequest(token, stash, fields, i.user.id);
    if (!res.ok) {
      store.saveIntake(token, stash); // keep it re-approvable so the card still works
      return void i.editReply(`❌ Brief invalid:\n• ${res.errors.join("\n• ")}\nThe request is still in the queue — Edit and submit again.`);
    }
    await i.editReply(`🚀 Approved & launched for <@${stash.requesterId}>: ${res.runId}${res.warning ? `\n${res.warning}` : ""}`);
  }
}

// ── buttons ──────────────────────────────────────────────────────────────────
async function onButton(i: ButtonInteraction) {
  // Intake approve/reject (admin-only).
  if (i.customId.startsWith("req:")) {
    if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });
    const action = i.customId.split(":")[1]; // approve | reject
    const token = i.customId.split(":").slice(2).join(":");
    const peek = store.takeIntake<{ requesterId: string; idea: string; suggestedName: string | null; gender: Concept["gender"]; refUrls: string[] }>(token);
    if (!peek) return void i.reply({ ephemeral: true, content: "This request expired." });
    if (action === "reject") {
      await i.update({ components: [] }).catch(() => {});
      await i.followUp({ content: `🗑️ Rejected by <@${i.user.id}>.` });
      await setPublicRequest(token, `🗂️ **Request** from <@${peek.requesterId}> — not selected this time.`);
      const u = await client.users.fetch(peek.requesterId).catch(() => null);
      await u?.send("Thanks for your request — it wasn't picked up this time. Feel free to submit another idea.").catch(() => {});
      return;
    }
    // approve → auto-EXPAND the loose idea into a full concept (lazy: nothing ran
    // until now), then re-card with Edit / Launch-as-is / Reject. A modal can't be
    // shown after an async call, so we expand here and the pre-filled modal opens
    // instantly later from the ✏️ button.
    await i.update({ embeds: i.message.embeds, components: [], content: "✨ Expanding the concept… (a few seconds)" }).catch(() => {});
    store.saveMsgRef(`reqcard:${token}`, i.message.channelId, i.message.id);
    const { concept: ex, ok } = await expandConcept(peek.idea, { suggestedName: peek.suggestedName, gender: peek.gender });
    // Stash everything the modal/launch needs (expansion + requester context).
    store.saveIntake(token, { ...peek, expanded: ex });
    const card = expandedCard({
      token, requesterId: peek.requesterId, gender: peek.gender,
      name: ex.name, theme: ex.theme, mainTagline: ex.mainTagline,
      copyLines: ex.copyLines, extraInstructions: ex.extraInstructions, ok,
    });
    await i.editReply({ content: "", ...card }).catch(() => {});
    return;
  }

  // ✏️ Review & edit → open the pre-filled modal (data already stashed → instant).
  if (i.customId.startsWith("reqedit:")) {
    if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });
    const token = i.customId.slice("reqedit:".length);
    const peek = store.takeIntake<ReqStash>(token);
    if (!peek) return void i.reply({ ephemeral: true, content: "This request expired." });
    store.saveIntake(token, peek); // peek-without-consume: keep it for the submit
    const ex = peek.expanded;
    await i.showModal(reqModal(token, {
      name: ex?.name ?? peek.suggestedName ?? "", theme: ex?.theme ?? peek.idea,
      mainTagline: ex?.mainTagline, copyLines: ex?.copyLines, extraInstructions: ex?.extraInstructions,
    }));
    return;
  }

  // 🚀 Launch as-is → send the expanded concept straight to compose, no editing.
  if (i.customId.startsWith("reqlaunch:")) {
    if (!(await isAdmin(i))) return void i.reply({ ephemeral: true, content: "Admins only." });
    const token = i.customId.slice("reqlaunch:".length);
    const peek = store.takeIntake<ReqStash>(token);
    if (!peek || !peek.expanded) return void i.reply({ ephemeral: true, content: "This request expired — re-approve it." });
    await i.deferReply({ ephemeral: true });
    const res = await launchRequest(token, peek, peek.expanded, i.user.id);
    if (!res.ok) {
      store.saveIntake(token, peek); // keep it re-approvable
      return void i.editReply(`❌ Couldn't launch:\n• ${res.errors.join("\n• ")}\nTry ✏️ Review & edit to fix it.`);
    }
    await i.editReply(`🚀 Launched \`${res.runId}\` as-is.${res.warning ? `\n${res.warning}` : ""}`);
    return;
  }

  if (i.customId.startsWith("start:")) {
    const token = i.customId.slice("start:".length);
    const concept = store.takeIntake<Concept>(token);
    if (!concept) return void i.reply({ ephemeral: true, content: "This intake expired — run /concept again." });
    await i.deferReply();
    const thread = i.channel as ThreadChannel;
    concept.refImages = await collectRefs(thread, concept.slug);
    const v = validateConcept(concept);
    if (!v.ok) return void i.editReply(`❌ Brief invalid:\n• ${v.errors.join("\n• ")}`);
    await i.message.edit({ components: [] }).catch(() => {}); // strip the now-spent Start button
    const refNote = `refs: ${v.value.refImages.length ? v.value.refImages.join(", ") : "none"}`;
    // Direction pick first (reusing THIS thread); the run starts on the pick.
    if (await offerDirections(v.value, thread, null)) {
      await i.editReply(`🎨 Brief locked (${refNote}) — pick a direction below to start.`);
      return;
    }
    const runId = await beginRun(v.value, thread, null);
    await i.editReply(`🚀 Started \`${runId}\` (${refNote}).`);
    return;
  }

  // Generate-gate end buttons: stop (soft, reopenable) or discard (hard, forget).
  // `giveup:` is the legacy id — treat any stale ones as a soft stop.
  if (i.customId.startsWith("stop:") || i.customId.startsWith("discard:") || i.customId.startsWith("giveup:")) {
    const hard = i.customId.startsWith("discard:");
    const { runId } = cid.parse(i.customId);
    const r = store.runById(runId);
    if (!r) return void i.reply({ ephemeral: true, content: "Unknown run." });
    // Guard: only valid while the generate gate is still open — never end a run
    // that already advanced (e.g. the image was dropped and it's mid-QC).
    if (!sm.openGates(runId).some((g) => g.kind === "generate")) {
      await i.update({ components: [] }).catch(() => {});
      return void i.followUp({ ephemeral: true, content: "That generation step is already handled." });
    }
    await i.update({ components: [] }).catch(() => {});
    if (hard) await hardDiscard(runId, i.user.id);
    else await softStop(runId, i.user.id);
    return;
  }

  // ✏️ Edit button on a prompt-QC card → open the editable modal pre-filled with
  // the composed prompt. (showModal must be the immediate ack; the DB read is fast.)
  if (i.customId.startsWith("qcedit:")) {
    const { runId, iteration, nodeId } = cid.parse(i.customId);
    const prompt = sm.composedPrompt(runId) ?? "";
    if (!prompt) return void i.reply({ ephemeral: true, content: "No composed prompt to edit yet." });
    if (prompt.length > 4000) {
      return void i.reply({ ephemeral: true, content: `⚠️ This prompt is ${prompt.length} chars — over Discord's 4000-char edit field. Use **Deny + note** for now (or ping me to add multi-field editing).` });
    }
    await i.showModal(editPromptModal(runId, nodeId, iteration, prompt));
    return;
  }

  // 🔄 Re-roll: author a fresh set of pitches for the same concept. takeIntake
  // consumes atomically and the stash is re-saved under a NEW token, so a click
  // on the stale card bounces on "already picked".
  if (i.customId.startsWith("dirreroll:")) {
    const token = i.customId.slice("dirreroll:".length);
    const stash = store.takeIntake<{ concept: Concept; pitches: string[]; requesterId: string | null; threadId: string }>(token);
    if (!stash) return void i.reply({ ephemeral: true, content: "Already picked (or expired)." }).catch(() => {});
    await i.deferUpdate().catch(() => {});
    await i.editReply({ components: [] }).catch(() => {}); // no picks while authoring
    const rolled = await pitchDirections(stash.concept, config.directions);
    const pitches = rolled.length >= 2 ? rolled : stash.pitches; // keep the old set if authoring fails
    const newToken = `dir:${stash.concept.slug}:${Date.now().toString(36)}`;
    store.saveIntake(newToken, { ...stash, pitches });
    const body = pitches.map((p, n) => `**${n + 1}.** ${p}`).join("\n\n");
    await i.editReply({
      content: `${rolled.length >= 2 ? "🔄 **Re-rolled** — pick direction(s)" : "⚠️ Re-roll failed — keeping the previous set"} (or let compose decide):\n\n${body}`.slice(0, 1990),
      components: directionComponents(newToken, pitches),
    }).catch(() => {});
    return;
  }

  // Pre-run direction pick: [1..N] sets the pitch as the concept's artwork
  // direction, 🎲 skips — either way the run starts now. takeIntake consumes
  // the stash atomically, so double-clicks bounce on "already picked".
  // (Numbered-button picks only arrive from pre-multiselect cards; 🎲 skip is
  // shared with the current card.)
  if (i.customId.startsWith("dirpick:")) {
    // dirpick:<idx|skip>:<token>
    const [, sel, ...rest] = i.customId.split(":");
    const token = rest.join(":");
    const stash = store.takeIntake<{ concept: Concept; pitches: string[]; requesterId: string | null; threadId: string }>(token);
    if (!stash) return void i.reply({ ephemeral: true, content: "Already picked (or expired)." }).catch(() => {});
    await i.deferUpdate().catch(() => {});
    await i.editReply({ components: [] }).catch(() => {}); // strip pick buttons immediately
    const idx = sel === "skip" ? -1 : Number(sel);
    if (idx >= 0 && stash.pitches[idx]) stash.concept.artwork = stash.pitches[idx];
    const thread = i.channel?.isThread() ? (i.channel as ThreadChannel) : await getThread(stash.threadId);
    if (!thread) return void i.followUp({ ephemeral: true, content: "Thread is gone — relaunch the concept." }).catch(() => {});
    const runId = await beginRun(stash.concept, thread, stash.requesterId);
    await i.followUp(idx >= 0
      ? `🎨 Direction **${idx + 1}** chosen by <@${i.user.id}> — \`${runId}\` is composing from it.`
      : `🎲 Compose's call — \`${runId}\` running.`);
    return;
  }

  if (i.customId.startsWith("qc:")) {
    // qc:<approve|deny>:<runId>:<iteration>:<gateSuffix>  — nodeId is rebuilt from
    // the runId's slug (back-compat: old cards carry the full nodeId, handled too).
    const parts = i.customId.split(":");
    const realKind = parts[1], runId = parts[2], iteration = Number(parts[3]) || 0, nodeId = cid.node(runId, parts.slice(4).join(":"));
    const r = store.runById(runId);
    if (!r) return void i.reply({ ephemeral: true, content: "Unknown run." });
    if (realKind === "deny") return void i.showModal(denyNoteModal(runId, nodeId, iteration));
    // Idempotence guard BEFORE any await (double-click protection), then ack
    // within Discord's 3s window and strip the buttons BEFORE the slow
    // smithers approve+resume (a `bunx` cold-start can exceed 3s).
    const akey = `resolved:${r.runId}:${iteration}:${nodeId}`;
    if (store.hasSeen(akey)) return void i.reply({ ephemeral: true, content: "Already decided — this gate is resolved." }).catch(() => {});
    store.mark(akey);
    await i.deferUpdate().catch(() => {});
    await i.editReply({ components: [] }).catch(() => {});
    await sm.approve(r.runId, nodeId, iteration, r.inputJson ?? "", i.user.username);
    store.takeMsgRef(`card:${r.runId}:${iteration}:${nodeId}`); // drop the now-resolved card ref
    await i.followUp(`✅ Approved by <@${i.user.id}>.`);
  }
}

// ── select menus ─────────────────────────────────────────────────────────────
// Direction multi-pick: ONE RUN PER TICKED PITCH. The first pick runs in this
// thread under the concept's own slug; each extra pick gets a sibling slug
// (<slug>_dN) and its own thread so outputs, gates, and final files never
// collide. takeIntake is atomic, so a double fire bounces on "already picked".
async function onSelect(i: StringSelectMenuInteraction) {
  if (!i.customId.startsWith("dirsel:")) return;
  const token = i.customId.slice("dirsel:".length);
  const stash = store.takeIntake<{ concept: Concept; pitches: string[]; requesterId: string | null; threadId: string }>(token);
  if (!stash) return void i.reply({ ephemeral: true, content: "Already picked (or expired)." }).catch(() => {});
  await i.deferUpdate().catch(() => {});
  await i.editReply({ components: [] }).catch(() => {}); // strip while launching
  const picks = [...new Set(i.values.map(Number))].filter((n) => stash.pitches[n] != null).sort((a, b) => a - b);
  const thread = i.channel?.isThread() ? (i.channel as ThreadChannel) : await getThread(stash.threadId);
  if (!thread || !picks.length) return void i.followUp({ ephemeral: true, content: "Thread is gone — relaunch the concept." }).catch(() => {});
  const first = { ...stash.concept, artwork: stash.pitches[picks[0]] };
  const firstRun = await beginRun(first, thread, stash.requesterId);
  const lines = [`🎨 Direction **${picks[0] + 1}** picked by <@${i.user.id}> — \`${firstRun}\` composing in this thread.`];
  const qc = (await client.channels.fetch(config.channels.qc).catch(() => null)) as TextChannel | null;
  for (const idx of picks.slice(1)) {
    const clone = { ...stash.concept, slug: directionSlug(stash.concept.slug, idx + 1), artwork: stash.pitches[idx] };
    const t = qc
      ? await qc.threads.create({ name: clone.slug.slice(0, 90), autoArchiveDuration: 1440, type: ChannelType.PublicThread }).catch(() => null)
      : null;
    if (!t) { lines.push(`⚠️ Couldn't open a thread for direction ${idx + 1} — skipped.`); continue; }
    await t.send(`🎨 **Direction ${idx + 1}** of **${stash.concept.name}**: ${stash.pitches[idx]}`.slice(0, 1900)).catch(() => {});
    const runId = await beginRun(clone, t, stash.requesterId);
    lines.push(`🎨 Direction **${idx + 1}** → \`${runId}\` in <#${t.id}>.`);
  }
  await i.followUp(lines.join("\n").slice(0, 1900)).catch(() => {});
}

// ── message drops (manual-gen handoff) ───────────────────────────────────────
async function onMessage(msg: Message) {
  if (msg.author.bot || !msg.channel.isThread()) return;
  const r = store.runByThread(msg.channelId);
  if (!r || r.status !== "active") return;
  const imgs = [...msg.attachments.values()].filter((a) => isImage(a.contentType, a.name ?? "", a.size));
  if (imgs.length === 0) return;

  // Is the run currently waiting at the manual-gen gate? (If not, these are
  // reference images dropped before Start — ignore them here.)
  const gate = sm.openGates(r.runId).find((g) => g.kind === "generate");
  if (!gate) return;

  const dir = `outputs/${r.slug}/candidates`;
  const existing = existsSync(resolve(config.projectRoot, dir))
    ? (await readdir(resolve(config.projectRoot, dir))).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).length
    : 0;
  const savePath = `${dir}/attempt${existing + 1}.png`;
  await download(imgs[0].url, resolve(config.projectRoot, savePath));
  store.mark(`resolved:${r.runId}:${gate.iteration}:${gate.nodeId}`);
  await sm.submitGenerated(r.runId, gate.nodeId, gate.iteration, r.inputJson ?? "", msg.author.username, {
    slug: r.slug, imagePath: savePath, ok: true,
  });
  // the "skip generation" button on the drop card no longer applies
  await clearCardButtons(`drop:${r.runId}:${gate.iteration}`);
  await msg.reply(`📥 Saved as \`${savePath}\` — running image QC…`);
}

// ── observability: live progress, stall watchdog, status snapshot ────────────
function firstIssue(issuesJson: string | null): string {
  if (!issuesJson) return "(see thread)";
  try { const a = JSON.parse(issuesJson); if (Array.isArray(a) && a.length) return String(a[0]); } catch {}
  return issuesJson.slice(0, 160);
}

// WHY a run ended not-accepted, from the most informative durable signal: a
// failed final generation attempt (its note holds the real error, e.g. an
// OpenAI 400), else the last image-QC rejection. Null when there's no story.
function failureReason(runId: string): string | null {
  const gens = sm.generateRows(runId);
  const last = gens[gens.length - 1];
  if (last && !last.ok && last.note) {
    const failed = gens.filter((g) => !g.ok).length;
    return `${failed}/${gens.length} generation attempts failed — last error: ${last.note}`.slice(0, 500);
  }
  const rej = sm.lastImageReject(runId);
  if (rej) return `image QC rejected the last attempt: ${rej.issues[0] ?? "(no detail)"}`.slice(0, 500);
  return null;
}

// One-line human stage label for a run (used by /status + stall warnings).
function stageLabel(runId: string): string {
  const gates = sm.openGates(runId);
  if (gates.length) {
    const g = gates[0];
    if (g.kind === "prompt") return `⏳ awaiting prompt approval (iter ${g.iteration})`;
    if (g.kind === "image") return `⏳ awaiting image approval (iter ${g.iteration})`;
    if (g.kind === "generate") return "⏳ awaiting PNG drop";
  }
  const s = sm.runSnapshot(runId);
  if (s.status && !["running", "waiting-approval", "waiting-event"].includes(s.status)) return s.status;
  if (s.attempts > 0) return `🎨 attempt ${s.attempts}${s.lastImageJudge ? `, auto-QC: ${s.lastImageJudge.verdict}` : ", judging…"}`;
  if (s.composes > 0) return `📝 prompt composed${s.lastPromptJudge ? `, auto-QC: ${s.lastPromptJudge.verdict}` : ""}`;
  return s.status || "running";
}

// Post each NEW auto-stage transition (generate / auto-QC verdict) into the
// thread once, so the thread is a live activity log between human gates.
async function postProgress(r: RunRow, thread: ThreadChannel) {
  for (const g of sm.generateRows(r.runId)) {
    if (!store.firstSeen(`prog:gen:${r.runId}:${g.iteration}`)) continue;
    if (g.ok) await thread.send(`🎨 Generated image **attempt ${g.iteration + 1}**.`).catch(() => {});
    else
      await thread
        .send(`⚠️ **Attempt ${g.iteration + 1} failed to generate:** ${g.note || "(no detail)"}`.slice(0, 1900))
        .catch(() => {});
  }
  for (const j of sm.imageJudgeRows(r.runId)) {
    if (!store.firstSeen(`prog:ijudge:${r.runId}:${j.iteration}`)) continue;
    if (j.verdict === "reject")
      await thread.send(`🤖 Auto-QC **rejected** attempt ${j.iteration + 1}: _${firstIssue(j.issues)}_ — regenerating…`.slice(0, 1900)).catch(() => {});
    else if (j.verdict === "accept")
      await thread.send(`✅ Attempt ${j.iteration + 1} **passed** auto-QC.`).catch(() => {});
  }
  for (const j of sm.promptJudgeRows(r.runId)) {
    if (!store.firstSeen(`prog:pjudge:${r.runId}:${j.iteration}`)) continue;
    if (j.verdict === "revise" || j.verdict === "reject")
      await thread.send(`🤖 Auto-QC asked to **revise the prompt**: _${firstIssue(j.issues)}_ — recomposing…`.slice(0, 1900)).catch(() => {});
  }
}

// Warn once per stall-window if a running (non-gated) run goes quiet. A run
// parked at a human gate is NOT stalled — it's waiting on you.
async function checkStall(r: RunRow, thread: ThreadChannel) {
  if (sm.openGates(r.runId).length > 0) return;
  if (sm.runState(r.runId) !== "active") return;
  const last = sm.lastActivityMs(r.runId);
  if (!last) return;
  const idleMs = Date.now() - last;
  const mins = Math.round(idleMs / 60_000);
  // Hard auto-kill: idle past KILL_MIN with no gate + no live process means the
  // run is a zombie (its process died, e.g. on a container restart) that will
  // never self-resolve. Cancel it, mark done, stop tracking — so it doesn't warn
  // forever and its slot is freed. (Legit long steps keep heartbeating → not idle.)
  if (config.killMin > 0 && idleMs > config.killMin * 60_000) {
    await sm.cancel(r.runId).catch(() => {});
    store.setRunStatus(r.runId, "done");
    await thread.send(`🛑 **${displayName(r)}** auto-cancelled — stalled ${mins} min with no activity (its run process is gone). Re-run it fresh if you still want it.`).catch(() => {});
    await postStatus(`🛑 \`${r.slug}\` auto-cancelled (stalled ${mins}m)`);
    return;
  }
  const stallMs = config.stallMin * 60_000;
  if (idleMs < stallMs) return;
  const bucket = Math.floor(idleMs / stallMs); // re-warn each window, not every tick
  if (!store.firstSeen(`stall:${r.runId}:${bucket}`)) return;
  await thread.send(`⚠️ **${displayName(r)}** looks stalled — no activity for ~${mins} min. Last stage: ${stageLabel(r.runId)}. Auto-cancels at ${config.killMin} min if it stays dead.`).catch(() => {});
  await postStatus(`⚠️ \`${r.slug}\` possibly stalled (${mins}m idle)`);
}

// On startup, mark existing progress rows as already-seen WITHOUT posting, so a
// mid-run restart doesn't backfill a burst of stale transition messages.
function seedProgress() {
  for (const r of store.activeRuns()) {
    for (const g of sm.generateRows(r.runId)) store.mark(`prog:gen:${r.runId}:${g.iteration}`);
    for (const j of sm.imageJudgeRows(r.runId)) store.mark(`prog:ijudge:${r.runId}:${j.iteration}`);
    for (const j of sm.promptJudgeRows(r.runId)) store.mark(`prog:pjudge:${r.runId}:${j.iteration}`);
  }
}

// ── watcher: mirror open gates / completion into threads ─────────────────────
// Reads Smithers' durable DB directly (sm.openGates / sm.runState). Each gate
// (prompt QC, manual-gen, image QC) is an approval node; we post its card once,
// keyed by run+iteration+node so loop re-asks post fresh cards.
async function tick() {
  for (const r of store.activeRuns()) {
    const thread = await getThread(r.threadId);
    if (!thread) continue;

    // 1. open gates → post the matching card once each. Mark "posted" ONLY after
    // the send actually succeeds, so a failed send (e.g. an over-long customId)
    // retries next tick instead of silently leaving a cardless gate forever.
    for (const g of sm.openGates(r.runId)) {
      const postedKey = `posted:${r.runId}:${g.iteration}:${g.nodeId}`;
      if (store.hasSeen(postedKey)) continue;
      if (g.kind === "generate") {
        // If this drop is a re-ask after an auto-QC rejection, tell the user WHY
        // the previous image bounced (its own message, so it's never truncated).
        const reject = sm.lastImageReject(r.runId);
        if (reject) {
          const why = reject.issues.map((s) => `• ${s}`).join("\n") || "(no detail)";
          await thread
            .send(`❌ **Image QC rejected the last drop:**\n${why}${reject.suggestions ? `\n_Suggestion:_ ${reject.suggestions}` : ""}`.slice(0, 1900))
            .catch(() => {});
        }
        const promptFull = (await finalPromptFor(r)) ?? "(use the prompt approved above)";
        // Discord caps a message at 2000 chars; the composed prompt is usually
        // longer. Inline it in a code block when it fits, otherwise attach the
        // FULL prompt as a .txt (open + select-all = clean copy, never truncated).
        const fits = promptFull.length <= 1850;
        const payload = fits
          ? { content: `🎨 **Generate this and drop the PNG in this thread:**\n\`\`\`\n${promptFull}\n\`\`\`` }
          : {
              content: `🎨 **Generate this and drop the PNG in this thread.** The prompt is long, so it's attached as \`${r.slug}-prompt.txt\` — open it and copy the whole thing into your image tool.`,
              files: [new AttachmentBuilder(Buffer.from(promptFull, "utf8"), { name: `${r.slug}-prompt.txt` })],
            };
        const msg = await thread.send({ ...payload, components: [stopDiscardRow(r.runId, g.nodeId, g.iteration)] }).catch(() => null);
        if (msg) { store.mark(postedKey); store.saveMsgRef(`drop:${r.runId}:${g.iteration}`, thread.id, msg.id); }
      } else {
        const isImg = g.kind === "image";
        const files = isImg ? await candidateAttachment(r.runId, r.slug) : [];
        const card = qcMessage({
          runId: r.runId, nodeId: g.nodeId, iteration: g.iteration,
          title: `${isImg ? "🖼️ Image" : "📝 Prompt"} QC — ${r.slug}`,
          summary: isImg
            ? "Review the generated image above and decide. Deny opens a note that feeds a regenerate."
            : (sm.composedPrompt(r.runId) ?? "Prompt composed. Approve to generate, or Deny with a note to revise."),
        });
        const sent = await thread.send({ ...card, files }).catch(() => null);
        if (sent) { store.mark(postedKey); store.saveMsgRef(`card:${r.runId}:${g.iteration}:${g.nodeId}`, thread.id, sent.id); }
      }
    }

    // 1b. live progress (auto-gen/auto-QC transitions) + stall watchdog.
    await postProgress(r, thread);
    await checkStall(r, thread);

    // 2. terminal → outcome + outputs (once)
    const state = sm.runState(r.runId);
    if (state === "completed" || state === "failed" || state === "cancelled") {
      if (store.firstSeen(`done:${r.runId}`)) {
        const finalPng = resolve(config.projectRoot, `outputs/${r.slug}/${r.slug}.png`);
        const accepted = existsSync(finalPng);
        // Public/requester-facing copy uses the product NAME (prettier than the
        // slug); status lines keep the slug since they're the admin's index.
        const name = displayName(r);
        const reason = accepted ? null : failureReason(r.runId);
        await thread.send(
          accepted
            ? "✅ **Accepted** — filed to outputs/."
            : `🏁 Finished (${state}) — not accepted.${reason ? `\n**Why:** ${reason}` : ""}`.slice(0, 1900),
        );
        await postStatus(
          (accepted
            ? `✅ \`${r.slug}\` accepted`
            : `🏁 \`${r.slug}\` finished (${state}, not accepted)${reason ? ` — ${reason}` : ""}`
          ).slice(0, 1900),
        );
        // The image itself only ever lives in the public #outputs gallery.
        // Requesters get a DM with a LINK to the gallery post (never the image).
        const requester = r.requesterId ? await client.users.fetch(r.requesterId).catch(() => null) : null;
        if (accepted) {
          const out = (await client.channels.fetch(config.channels.outputs).catch(() => null)) as TextChannel | null;
          const credit = r.requesterId ? ` · requested by <@${r.requesterId}>` : "";
          const posted = out ? await out.send({ content: `**${name}**${credit}`, files: [new AttachmentBuilder(finalPng)] }).catch(() => null) : null;
          if (requester && posted) await requester.send(`✅ Your "${name}" is ready — see it in the gallery: ${posted.url}`).catch(() => {});
        } else if (requester) {
          await requester.send(`Your approved request "${name}" didn't pan out after review. Feel free to submit another idea.`).catch(() => {});
        }
      }
      store.setRunStatus(r.runId, "done");
    }
  }
}

// ── wire up ──────────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isModalSubmit()) await onModal(i);
    else if (i.isButton()) await onButton(i);
    else if (i.isStringSelectMenu()) await onSelect(i);
  } catch (e) {
    console.error("interaction error", e);
    if (i.isRepliable()) i.reply({ ephemeral: true, content: `⚠️ ${String(e)}` }).catch(() => {});
  }
});
client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error("message error", e)));
client.once(Events.ClientReady, (c) => {
  console.log(`Bridge online as ${c.user.tag} · worker=${config.workerName} · backend=${config.backend}`);
  seedProgress(); // don't backfill old transitions for runs already in flight
  setInterval(() => tick().catch((e) => console.error("tick error", e)), config.pollMs);
});

client.login(config.botToken);
