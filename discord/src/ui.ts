// Discord component builders: QC embeds + approve/deny buttons, the deny-note
// modal, the /concept intake modal, and the "drop refs then Start" prompt.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// customId helpers (Discord caps customId at 100 chars). A gate nodeId is always
// `<slug>:<gate>` and the runId is `<slug>-<suffix>`, so embedding the FULL nodeId
// duplicated the slug and blew past 100 for long (auto-derived) slugs. We instead
// store only the gate suffix (e.g. "approve-prompt") and rebuild the nodeId from
// the runId's slug. Format: kind:runId:iteration:<gateSuffix>.
const gateSuffix = (nodeId: string) => (nodeId.includes(":") ? nodeId.slice(nodeId.indexOf(":") + 1) : nodeId);
// slug = runId up to the last "-" (the run suffix is base36, never contains "-").
const slugOfRun = (runId: string) => (runId.includes("-") ? runId.slice(0, runId.lastIndexOf("-")) : runId);
// Rebuild a full nodeId. Back-compat: if `tail` already contains a colon it's an
// OLD full-nodeId customId (pre-fix card still in a thread) → use it verbatim.
const nodeFrom = (runId: string, tail: string) => (tail.includes(":") ? tail : `${slugOfRun(runId)}:${tail}`);
export const cid = {
  approve: (runId: string, nodeId: string, iter: number) => `qc:approve:${runId}:${iter}:${gateSuffix(nodeId)}`,
  deny: (runId: string, nodeId: string, iter: number) => `qc:deny:${runId}:${iter}:${gateSuffix(nodeId)}`,
  denyModal: (runId: string, nodeId: string, iter: number) => `denynote:${runId}:${iter}:${gateSuffix(nodeId)}`,
  editPrompt: (runId: string, nodeId: string, iter: number) => `qcedit:${runId}:${iter}:${gateSuffix(nodeId)}`,
  // Pick alternate direction <idx> (0 = "B", 1 = "C") instead of the primary.
  // 5-part like qc:* — the handler splits it manually, not via cid.parse.
  useAlt: (runId: string, nodeId: string, iter: number, idx: number) => `qcuse:${idx}:${runId}:${iter}:${gateSuffix(nodeId)}`,
  editModal: (runId: string, nodeId: string, iter: number) => `editmodal:${runId}:${iter}:${gateSuffix(nodeId)}`,
  start: (token: string) => `start:${token}`,
  reqEdit: (token: string) => `reqedit:${token}`,
  reqLaunch: (token: string) => `reqlaunch:${token}`,
  giveUp: (runId: string, nodeId: string, iter: number) => `giveup:${runId}:${iter}:${gateSuffix(nodeId)}`,
  stop: (runId: string, nodeId: string, iter: number) => `stop:${runId}:${iter}:${gateSuffix(nodeId)}`,
  discard: (runId: string, nodeId: string, iter: number) => `discard:${runId}:${iter}:${gateSuffix(nodeId)}`,
  // Rebuild a full nodeId from a runId + gate suffix (used by the qc handler).
  node: (runId: string, tail: string) => nodeFrom(runId, tail),
  parse: (id: string) => {
    const [kind, runId, iter, ...rest] = id.split(":");
    return { kind, runId, iteration: Number(iter) || 0, nodeId: nodeFrom(runId, rest.join(":")) };
  },
};

export function qcMessage(opts: {
  runId: string; nodeId: string; iteration: number; title: string; summary: string;
  // Number of alternate directions available (prompt gates only) → adds a
  // "Use B" / "Use C" row. 0/undefined = classic card.
  alternates?: number;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const kind = opts.nodeId.includes("image") ? "🖼️ Image QC" : "📝 Prompt QC";
  const embed = new EmbedBuilder()
    .setTitle(cut(opts.title, 256))
    .setDescription(cut(opts.summary || "Review and decide.", 4000))
    .setFooter({ text: `${kind} · ${opts.nodeId}` });
  const buttons = [
    new ButtonBuilder().setCustomId(cid.approve(opts.runId, opts.nodeId, opts.iteration)).setLabel("Approve").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid.deny(opts.runId, opts.nodeId, opts.iteration)).setLabel("Deny + note").setStyle(ButtonStyle.Danger),
  ];
  // Prompt gates get a direct ✏️ Edit (edit the text → it becomes the final
  // prompt, bypassing recompose + judge). No edit for image gates.
  if (!opts.nodeId.includes("image")) {
    buttons.splice(1, 0, new ButtonBuilder().setCustomId(cid.editPrompt(opts.runId, opts.nodeId, opts.iteration)).setLabel("✏️ Edit").setStyle(ButtonStyle.Primary));
  }
  const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
  // Alternate directions (first compose only): Approve = primary ("A"); these
  // pick B/C instead — same mechanics as ✏️ Edit (exact text becomes final).
  const nAlts = Math.min(opts.alternates ?? 0, 3);
  if (nAlts > 0 && !opts.nodeId.includes("image")) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...Array.from({ length: nAlts }, (_, idx) =>
        new ButtonBuilder()
          .setCustomId(cid.useAlt(opts.runId, opts.nodeId, opts.iteration, idx))
          .setLabel(`Use ${"BCD"[idx]}`)
          .setStyle(ButtonStyle.Secondary),
      ),
    ));
  }
  return { embeds: [embed], components: rows };
}

// Modal to edit the composed prompt directly. The submitted text becomes the
// run's FINAL prompt as-is. Discord caps a field at 4000 chars — a longer prompt
// is pre-filled truncated (the caller warns), which is rare.
export function editPromptModal(runId: string, nodeId: string, iter: number, currentPrompt: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid.editModal(runId, nodeId, iter))
    .setTitle("Edit the final prompt")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("prompt")
          .setLabel("This exact text becomes the image prompt")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setValue((currentPrompt || "").slice(0, 4000)),
      ),
    );
}

export function denyNoteModal(runId: string, nodeId: string, iter: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(cid.denyModal(runId, nodeId, iter))
    .setTitle("Reason for revision")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("What should change? (feeds the revise loop)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(900),
      ),
    );
}

// /concept modal — the common-case brief. Rich briefs use /concept-json.
export function conceptModal(token: string): ModalBuilder {
  const field = (id: string, label: string, style: TextInputStyle, required: boolean, ph = "") =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setPlaceholder(ph),
    );
  return new ModalBuilder()
    .setCustomId(`conceptmodal:${token}`)
    .setTitle("New concept brief")
    .addComponents(
      field("name", "Product name (as printed)", TextInputStyle.Short, true, "POWER ROD 11"),
      field("theme", "Parody theme / world", TextInputStyle.Paragraph, true, "everything expands from this — e.g. late-90s arcade bass fishing, Dreamcast cover art"),
      field("mainTagline", "Main tagline (optional)", TextInputStyle.Short, false, "blank = compose invents it · prefix = for verbatim, e.g. =HOOK THE BIG ONE"),
      field("copyLines", "Copy lines (one per line, optional)", TextInputStyle.Paragraph, false, "blank = invented · prefix a line with = to force verbatim, e.g. =MAXIMUM LINE TENSION"),
      field("extraInstructions", "Extra instructions (optional)", TextInputStyle.Paragraph, false, "Add a rainbow FISH!! graphic. No SEGA logo."),
    );
}

export function startRow(token: string, runId = ""): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid.start(token)).setLabel("▶ Start run").setStyle(ButtonStyle.Primary),
  );
  return row;
}

// Two ways to end a run from the generate gate:
//  • Stop (soft)    — shelve it; recoverable later with /reopen.
//  • Discard (hard) — forget it on the Discord side; not recoverable.
export function stopDiscardRow(runId: string, nodeId: string, iter: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid.stop(runId, nodeId, iter)).setLabel("⏸ Stop (resume later)").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid.discard(runId, nodeId, iter)).setLabel("🗑 Discard").setStyle(ButtonStyle.Danger),
  );
}

// ── request intake (admin-only) ──────────────────────────────────────────────
export function intakeCard(opts: {
  token: string; requesterTag: string; requesterId: string;
  idea: string; suggestedName: string | null; gender: string; refCount: number;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle("📨 New generate request")
    .setDescription(cut(opts.idea, 3500))
    .addFields(
      { name: "From", value: `<@${opts.requesterId}>`, inline: true },
      { name: "Suggested name", value: opts.suggestedName || "—", inline: true },
      { name: "Audience", value: opts.gender, inline: true },
      { name: "Ref images", value: String(opts.refCount), inline: true },
    )
    .setFooter({ text: "Approve to structure + run privately. The requester sees none of the internals." });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`req:approve:${opts.token}`).setLabel("Approve → expand").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`req:reject:${opts.token}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// Preview of the auto-expanded concept, shown after Approve. The admin can edit
// it (✏️) or send it straight to compose (🚀). Slug is auto-derived from name.
export function expandedCard(opts: {
  token: string; requesterId: string; gender: string; name: string; theme: string;
  mainTagline: string; copyLines: string[]; extraInstructions: string; ok: boolean;
}): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const copy = opts.copyLines.length ? opts.copyLines.map((l) => `• ${l}`).join("\n") : "_(compose will invent)_";
  const embed = new EmbedBuilder()
    .setTitle(cut(`✨ ${opts.name}`, 256))
    .setDescription(cut(opts.theme, 4000))
    .addFields(
      { name: "Main tagline", value: cut(opts.mainTagline || "_(compose will invent)_", 1024) },
      { name: "Copy lines", value: cut(copy, 1024) },
      ...(opts.extraInstructions ? [{ name: "Extra", value: cut(opts.extraInstructions, 1024) }] : []),
      { name: "From", value: `<@${opts.requesterId}>`, inline: true },
      { name: "Audience", value: opts.gender, inline: true },
    )
    .setFooter({ text: opts.ok ? "Auto-expanded — edit it or launch as-is." : "⚠️ Auto-expand fell back to the raw idea — edit before launching." });
  return { embeds: [embed], components: [reviewLaunchRow(opts.token)] };
}

// Buttons under the expanded preview: edit (opens pre-filled modal), launch
// as-is, or reject.
export function reviewLaunchRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid.reqEdit(token)).setLabel("✏️ Review & edit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid.reqLaunch(token)).setLabel("🚀 Launch as-is").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`req:reject:${token}`).setLabel("🗑 Reject").setStyle(ButtonStyle.Danger),
  );
}

// Admin's review modal at approval — PRE-FILLED with the auto-expanded concept.
// Slug is auto-derived from the name (admins don't type it), freeing the 5th
// slot for the main tagline so the fields match the /concept modal.
export function reqModal(
  token: string,
  prefill: { name: string; theme: string; mainTagline?: string; copyLines?: string[]; extraInstructions?: string },
): ModalBuilder {
  const field = (id: string, label: string, style: TextInputStyle, required: boolean, value = "", ph = "") => {
    const ti = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
    if (value) ti.setValue(value.slice(0, style === TextInputStyle.Short ? 100 : 3500));
    if (ph) ti.setPlaceholder(ph);
    return new ActionRowBuilder<TextInputBuilder>().addComponents(ti);
  };
  return new ModalBuilder()
    .setCustomId(`reqmodal:${token}`)
    .setTitle("Review this concept")
    .addComponents(
      field("name", "Product name (as printed)", TextInputStyle.Short, true, prefill.name),
      field("theme", "Parody theme / world", TextInputStyle.Paragraph, true, prefill.theme),
      field("mainTagline", "Main tagline", TextInputStyle.Short, false, prefill.mainTagline ?? "", "blank = compose invents · prefix = to force verbatim"),
      field("copyLines", "Copy lines (one per line)", TextInputStyle.Paragraph, false, (prefill.copyLines ?? []).join("\n")),
      field("extraInstructions", "Extra instructions (optional)", TextInputStyle.Paragraph, false, prefill.extraInstructions ?? ""),
    );
}
