#!/bin/bash
# launchd entrypoint for the Discord worker. launchd does NOT inherit your shell
# env, so pin the PATH to the tools the bot + its agents need: bun/bunx (spawns
# `bunx smithers-orchestrator`), claude (compose/judge/generate agents), and the
# system utils. HOME must point at the real home so the agents' `claude` finds
# its Max-subscription login under ~/.claude. All secrets/knobs load from .env
# via discord/src/config.ts, so we don't export them here.
export HOME="/Users/juliotavarez"
export PATH="/Users/juliotavarez/.bun/bin:/Users/juliotavarez/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DEBUG_SMITHERS=1   # verbose smithers spawn/exit logging while we stabilize
cd /Users/Shared/programs/dickpillnft || exit 1
exec bun run discord/src/bot.ts
