// First-boot connectivity check. After filling .env, run:  bun run preflight
// Verifies: the bot is in your guild, every configured channel exists and is
// postable with the right permissions, the admin role resolves, and slash
// commands are registered. Exits non-zero if anything's off, so you catch a bad
// ID or a missing permission BEFORE a real run.
import {
  Client, GatewayIntentBits, PermissionFlagsBits as P, type PermissionsBitField,
} from "discord.js";
import { config } from "./src/config";

const P_NAMES: Record<string, bigint> = {
  ViewChannel: P.ViewChannel, SendMessages: P.SendMessages,
  CreatePublicThreads: P.CreatePublicThreads, SendMessagesInThreads: P.SendMessagesInThreads,
  AttachFiles: P.AttachFiles, EmbedLinks: P.EmbedLinks,
};
// what the bot needs in each channel
const NEED: Record<string, string[]> = {
  status: ["ViewChannel", "SendMessages"],
  qc: ["ViewChannel", "SendMessages", "CreatePublicThreads", "SendMessagesInThreads", "AttachFiles"],
  outputs: ["ViewChannel", "SendMessages", "AttachFiles", "EmbedLinks"],
  intake: ["ViewChannel", "SendMessages"],
  requests: ["ViewChannel", "SendMessages"],
};

let failures = 0;
const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => { console.log(`  ❌ ${m}`); failures++; };
const warn = (m: string) => console.log(`  ⚠️  ${m}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}\n`);

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    bad(`Bot is not in guild ${config.guildId} (invite it, or fix DISCORD_GUILD_ID).`);
    return finish();
  }
  ok(`In guild: ${guild.name}`);
  const me = await guild.members.fetchMe();

  // channels
  const channels: [string, string][] = [
    ["status", config.channels.status],
    ["qc", config.channels.qc],
    ["outputs", config.channels.outputs],
  ];
  if (config.channels.intake) channels.push(["intake", config.channels.intake]);
  if (config.channels.requests) channels.push(["requests", config.channels.requests]);

  for (const [name, id] of channels) {
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch) { bad(`#${name}: channel ${id} not found in this guild`); continue; }
    const perms = ch.permissionsFor(me) as PermissionsBitField | null;
    const missing = NEED[name].filter((p) => !perms?.has(P_NAMES[p]));
    if (missing.length) bad(`#${name} (${ch.name}): bot missing ${missing.join(", ")}`);
    else ok(`#${name} (${ch.name}): postable`);
    // Name-mismatch guard: catches a wrong ID pasted into the wrong slot.
    if (ch.name !== name)
      bad(`DISCORD_${name.toUpperCase()}_CHANNEL_ID points at a channel named "${ch.name}" — wrong ID? Expected "${name}".`);
  }

  // admin role
  const role = await guild.roles.fetch(config.adminRoleId).catch(() => null);
  if (role) ok(`Admin role resolves: @${role.name} — make sure it's assigned to you`);
  else bad(`Admin role ${config.adminRoleId} not found (fix DISCORD_ADMIN_ROLE_ID)`);

  // registered commands
  const cmds = await guild.commands.fetch().catch(() => null);
  const names = cmds ? [...cmds.values()].map((c) => c.name) : [];
  for (const want of ["concept", "concept-json", "status", "cancel", "request"]) {
    if (names.includes(want)) ok(`/${want} registered`);
    else warn(`/${want} not registered yet — run: bun run register`);
  }

  if (!config.channels.intake || !config.channels.requests)
    warn("Request-intake channels not set — /request is disabled (admin-only worker).");
  warn("Cannot verify the MESSAGE CONTENT intent here — confirm it's ON in the Bot tab (needed for PNG drops).");

  finish();
});

function finish() {
  console.log(failures === 0 ? "\n✅ Preflight passed." : `\n❌ Preflight failed: ${failures} issue(s) above.`);
  client.destroy();
  process.exit(failures === 0 ? 0 : 1);
}

client.login(config.botToken).catch((e) => {
  console.error("Login failed — check DISCORD_BOT_TOKEN:", e.message);
  process.exit(1);
});
