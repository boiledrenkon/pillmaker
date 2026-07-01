// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Hello World
// smithers-description: The smallest possible workflow: one agent task that runs the prompt in .smithers/prompts/hello.mdx. Your starting point for authoring your own.
// smithers-tags: starter, hello-world
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import HelloPrompt from "../prompts/hello.mdx";

// What you pass in. `name` defaults to "world" so `workflow run hello` works
// with no arguments at all.
const inputSchema = z.object({
  name: z
    .string()
    .default("world")
    .describe("Who to greet. Try `--name Ada`."),
});

// What the agent must return: a single structured field, validated for you.
const greetingSchema = z.object({
  greeting: z.string().describe("A short, friendly one-sentence greeting."),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  greeting: greetingSchema,
});

/**
 * Hello World. One task: hand the agent the prompt in
 * `.smithers/prompts/hello.mdx` (edit that file to change what it does) and
 * capture its structured `greeting`. This is the template to copy when you
 * write your own workflow.
 *
 * Input fields arrive null when unsupplied, so coalesce `name` to its default.
 */
export default smithers((ctx) => (
  <Workflow name="hello">
    <Task id="greet" output={outputs.greeting} agent={agents.cheapFast}>
      <HelloPrompt name={ctx.input.name ?? "world"} />
    </Task>
  </Workflow>
));
