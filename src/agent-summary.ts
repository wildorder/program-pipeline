import { tail } from "./agent-runner.js";

/**
 * Every spawned agent ends its reply with a summary block, and the runner
 * reads it back verbatim.
 *
 * Before this, agent output had exactly two destinations: a machine parse
 * (findings, verdicts) or a failure path (`tail()` inside an error message).
 * A workstream that passed surfaced nothing about what the agent actually
 * concluded — the only record was the raw stdout firehose in the
 * per-workstream log, which is the entire transcript and therefore unread.
 * And when the pipeline was driven from inside an orchestrating agent
 * session, that orchestrator paraphrased whatever little did surface.
 *
 * The fix is the one the brief composer already applies in the other
 * direction: the package owns the contract. Every brief the runner composes
 * ends with the block below, every runner reads it back, and the text lands
 * in the events log as the agent wrote it — not summarized, not rewritten.
 *
 * A missing block is never fatal. An agent that forgets the fence still did
 * the work, and failing a verified workstream over a formatting slip would
 * trade a real result for a cosmetic one.
 */

const CONTRACT = `
## Summary (required)

End your reply with this block. It is the only part of your output a human
will read, so write it for a human:

\`\`\`summary
Two to five sentences: what you did, the decisions you made and why, and
anything you were unsure about or had to assume. Do not restate these
instructions.
\`\`\`

Put it last. If you also return a \`\`\`json block, both must be present.
`.trim();

/** The contract text, appended verbatim to every brief the runner composes. */
export function summaryContract(): string {
  return CONTRACT;
}

export interface AgentSummary {
  /** The agent's own words, or an output tail when it emitted no block. */
  text: string;
  /** False when no block was found and `text` is a fallback tail. */
  available: boolean;
}

/**
 * The last summary block in the output. Last rather than first for the same
 * reason {@link extractJson} takes the last json block: an agent that echoes
 * the contract back before answering would otherwise have its echo parsed as
 * the answer.
 */
export function extractSummary(output: string): string | undefined {
  const matches = [...output.matchAll(/```summary[^\S\r\n]*\r?\n([\s\S]*?)```/gu)];
  for (const match of matches.reverse()) {
    const text = match[1]?.trim();
    if (text !== undefined && text !== "") return text;
  }
  return undefined;
}

/**
 * The summary for an agent reply, degrading to an output tail when the agent
 * emitted no block. Never throws and never signals failure: callers record
 * what they got and carry on.
 */
export function resolveSummary(output: string, tailLimit = 600): AgentSummary {
  const text = extractSummary(output);
  if (text !== undefined) return { text, available: true };
  const fallback = tail(output, tailLimit).trim();
  return {
    text: fallback === "" ? "(no output)" : fallback,
    available: false,
  };
}

/**
 * Event payload fields, so every emitter names them the same way. `role` is
 * the job the agent held (`build`, `critic`, `writer`, `author`, `validator`,
 * `reviewer`), not the command it ran.
 *
 * `promptBytes` is deliberate telemetry: brief size is the input to every
 * decision about how much context an agent can be given, and estimating it
 * from spec line counts is guesswork. Recording it per invocation turns that
 * into a measurement after one real run.
 */
export function summaryEventData(
  role: string,
  prompt: string,
  summary: AgentSummary,
): Record<string, unknown> {
  return {
    role,
    summary: summary.text,
    summaryAvailable: summary.available,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
  };
}

/** Single-line form for progress output; the events log keeps the full text. */
export function summaryLine(summary: AgentSummary, limit = 240): string {
  const collapsed = summary.text.replace(/\s+/gu, " ").trim();
  const clipped =
    collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
  return summary.available ? clipped : `(no summary block) ${clipped}`;
}
