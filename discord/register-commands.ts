// One-off: register the bridge's slash commands to the guild. Run after editing
// commands:  bun run register
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./src/config";

const commands = [
  new SlashCommandBuilder()
    .setName("concept")
    .setDescription("Start a new concept: opens a brief, then a thread to drop refs and start.")
    .addStringOption((o) => o.setName("slug").setDescription("output folder name, e.g. power_rod_11").setRequired(true))
    .addStringOption((o) =>
      o.setName("gender").setDescription("audience").addChoices(
        { name: "male", value: "male" },
        { name: "female", value: "female" },
        { name: "couples", value: "couples" },
      ),
    ),
  new SlashCommandBuilder()
    .setName("concept-json")
    .setDescription("Start concept(s) from full JSON (one concept, or {concepts:[…]}).")
    .addStringOption((o) => o.setName("json").setDescription("paste the JSON"))
    .addAttachmentOption((o) => o.setName("file").setDescription("or attach a .json file")),
  new SlashCommandBuilder().setName("status").setDescription("List this worker's active runs."),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel the run for the current concept thread."),
  new SlashCommandBuilder()
    .setName("request")
    .setDescription("Submit a concept idea for review (admins approve before anything runs).")
    .addStringOption((o) => o.setName("idea").setDescription("describe the parody product you want").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("suggested product name (optional)"))
    .addStringOption((o) =>
      o.setName("gender").setDescription("audience").addChoices(
        { name: "male", value: "male" },
        { name: "female", value: "female" },
        { name: "couples", value: "couples" },
      ),
    )
    .addAttachmentOption((o) => o.setName("image1").setDescription("optional reference image"))
    .addAttachmentOption((o) => o.setName("image2").setDescription("optional reference image"))
    .addAttachmentOption((o) => o.setName("image3").setDescription("optional reference image")),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Soft-stop a run (shelve it; reopen later). Admin only.")
    .addStringOption((o) => o.setName("run").setDescription("runId or slug (default: this thread's run)")),
  new SlashCommandBuilder()
    .setName("discard")
    .setDescription("Hard-discard a run: forget it on Discord, not recoverable. Admin only.")
    .addStringOption((o) => o.setName("run").setDescription("runId or slug (default: this thread's run)")),
  new SlashCommandBuilder()
    .setName("reopen")
    .setDescription("Reopen a stopped/shelved run back to its gate. Admin only.")
    .addStringOption((o) => o.setName("run").setDescription("runId or slug (omit to list shelved runs)")),
  new SlashCommandBuilder()
    .setName("rerun")
    .setDescription("Re-run a finished/failed run fresh, keeping the original requester. Admin only.")
    .addStringOption((o) => o.setName("run").setDescription("runId or slug (default: this thread's run)")),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(config.botToken);
await rest.put(Routes.applicationGuildCommands(config.appId, config.guildId), { body: commands });
console.log(`Registered ${commands.length} commands to guild ${config.guildId}.`);
