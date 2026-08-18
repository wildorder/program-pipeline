import { spawn } from "node:child_process";
import type { AgentConfig, PipelineConfig } from "./pipeline-config.js";

export interface CommandResult {
  exitCode: number;
  output: string;
  /** Set when the prompt could not be fully delivered to the process stdin. */
  inputError?: string;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  prompt: string;
  promptMode: "stdin" | "argument";
  cwd: string;
  onOutput?: (chunk: string) => void;
}

export type AgentRunner = (invocation: AgentInvocation) => Promise<CommandResult>;
export type VerifyRunner = (command: string, cwd: string) => Promise<CommandResult>;

// In-memory output is kept to a bounded tail; full output belongs in the
// per-workstream log via onOutput streaming.
const OUTPUT_TAIL_LIMIT = 200_000;

/**
 * Environment for spawned agents: the parent may itself be an agent session
 * (Claude Code, Cursor), and inherited session markers can make the child CLI
 * behave as if attached to that session instead of running as a clean
 * headless agent.
 */
export function sanitizedEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    if (key === "CURSOR_AGENT" || key.startsWith("CURSOR_TRACE_")) continue;
    env[key] = value;
  }
  return env;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    shell: boolean;
    onOutput?: (chunk: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    let buffered = "";
    const push = (chunk: string): void => {
      options.onOutput?.(chunk);
      buffered = (buffered + chunk).slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", rejectPromise);
    let inputError: Error | undefined;
    child.stdin.on("error", (error: Error) => {
      inputError = error;
    });
    child.on("close", (code) =>
      resolvePromise({
        exitCode: code ?? 1,
        output: buffered,
        ...(inputError ? { inputError: inputError.message } : {}),
      }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export const defaultAgentRunner: AgentRunner = (invocation) =>
  runProcess(
    invocation.command,
    invocation.promptMode === "argument"
      ? [...invocation.args, invocation.prompt]
      : invocation.args,
    {
      cwd: invocation.cwd,
      // A shell re-parses the argument list, and on Windows cmd.exe mangles
      // multiline prompt arguments — so argument mode always spawns the
      // command directly. The shell is only used on Windows for stdin mode,
      // where it is needed to launch .cmd shims and cannot corrupt the
      // prompt (which travels via stdin, not argv).
      shell:
        process.platform === "win32" && invocation.promptMode !== "argument",
      env: sanitizedEnvironment(),
      ...(invocation.onOutput ? { onOutput: invocation.onOutput } : {}),
      ...(invocation.promptMode === "stdin"
        ? { input: invocation.prompt }
        : {}),
    },
  );

export const defaultVerifyRunner: VerifyRunner = (command, cwd) =>
  runProcess(command, [], { cwd, shell: true });

export function tail(output: string, limit = 2000): string {
  return output.length > limit ? output.slice(-limit) : output;
}

/**
 * The build agent: the `agent` block, or the environment fallback for hosts
 * that have no config file yet.
 */
export function resolveAgent(config: PipelineConfig): AgentConfig | undefined {
  if (config.agent) return config.agent;
  const command = process.env.PROGRAM_PIPELINE_AGENT_COMMAND;
  if (command && command.trim().length > 0) {
    return { command, args: [], promptMode: "stdin" };
  }
  return undefined;
}

export interface ResolvedRecoveryAgent {
  agent: AgentConfig;
  /** True when no dedicated recovery agent was configured. */
  borrowedBuildAgent: boolean;
}

/** Recovery agent, falling back explicitly to the normal build agent. */
export function resolveRecoveryAgent(
  config: PipelineConfig,
): ResolvedRecoveryAgent | undefined {
  if (config.recoveryAgent) {
    return { agent: config.recoveryAgent, borrowedBuildAgent: false };
  }
  const build = resolveAgent(config);
  if (build) return { agent: build, borrowedBuildAgent: true };
  return undefined;
}

export interface ResolvedAuthorAgent {
  agent: AgentConfig;
  /**
   * True when no `authorAgent` was configured and the build agent was
   * borrowed. Callers must surface this: the build agent is frequently set to
   * a cheap model on purpose, and silently promoting it to spec critic puts
   * that model in charge of judging and rewriting specs a stronger model
   * authored.
   */
  borrowedBuildAgent: boolean;
}

/**
 * The agent that reasons about specs in the convergence loop. Prefers the
 * dedicated `authorAgent` block and falls back to the build agent only as a
 * last resort, reporting that it did.
 */
export function resolveAuthorAgent(
  config: PipelineConfig,
): ResolvedAuthorAgent | undefined {
  if (config.authorAgent) {
    return { agent: config.authorAgent, borrowedBuildAgent: false };
  }
  const build = resolveAgent(config);
  if (build) return { agent: build, borrowedBuildAgent: true };
  return undefined;
}

/**
 * The validator agent for cross-provider critique. Unlike {@link resolveAgent}
 * this never falls back to the build agent: a validator that is the same
 * process as the author defeats the point of independent validation, so an
 * absent `validatorAgent` block is reported to the caller rather than
 * silently substituted.
 */
export function resolveValidatorAgent(
  config: PipelineConfig,
): AgentConfig | undefined {
  if (config.validatorAgent) return config.validatorAgent;
  const command = process.env.PROGRAM_PIPELINE_VALIDATOR_COMMAND;
  if (command && command.trim().length > 0) {
    return { command, args: [], promptMode: "stdin" };
  }
  return undefined;
}

/** Human-readable form of a resolved agent, for plan and approval output. */
export function describeAgent(agent: AgentConfig): string {
  return [agent.command, ...agent.args].join(" ");
}
