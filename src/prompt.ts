/**
 * A minimal keyboard-driven prompt set.
 *
 * Hand-rolled rather than pulled from a dependency: the primary invocation of
 * this CLI is `npx --yes @wildorder/program-pipeline`, where every transitive
 * dependency is a user-visible download, and these prompts need to render
 * per-row annotations (resolved path, detection state) that a generic
 * checkbox prompt fights.
 */

interface PromptInput {
  isTTY?: boolean | undefined;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  off: (event: "data", listener: (chunk: string) => void) => unknown;
  resume: () => unknown;
  pause: () => unknown;
}

interface PromptOutput {
  isTTY?: boolean | undefined;
  write: (chunk: string) => unknown;
}

export interface PromptStreams {
  input: PromptInput;
  output: PromptOutput;
}

export interface Choice<T> {
  value: T;
  label: string;
  /** Right-hand annotation, dimmed. */
  hint?: string;
}

type Key = "up" | "down" | "space" | "enter" | "toggleAll" | "abort" | "other";

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

export function defaultStreams(): PromptStreams {
  return { input: process.stdin, output: process.stdout };
}

/**
 * Prompting is only safe when a human is on both ends. The CLI is also driven
 * by npm lifecycle hooks, CI, and the packaged skills themselves — a blocking
 * read in any of those hangs the process.
 */
export function isInteractive(
  streams: PromptStreams = defaultStreams(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    Boolean(streams.input.isTTY) &&
    Boolean(streams.output.isTTY) &&
    typeof streams.input.setRawMode === "function" &&
    !env.CI
  );
}

function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;

  while (index < chunk.length) {
    const char = chunk[index] ?? "";

    if (char === "\u001B") {
      const next = chunk[index + 1];
      if (next === "[" || next === "O") {
        // Consume through the sequence's final byte so a function key never
        // leaks through as a stray character.
        let end = index + 2;
        while (end < chunk.length && !/[@-~]/u.test(chunk[end] ?? "")) end += 1;
        const final = chunk[end];
        keys.push(final === "A" ? "up" : final === "B" ? "down" : "other");
        index = end + 1;
        continue;
      }
      // A lone escape cancels; anything else is ignored.
      keys.push(next === undefined ? "abort" : "other");
      index += next === undefined ? 1 : 2;
      continue;
    }

    if (char === "\u0003") keys.push("abort");
    else if (char === "\r" || char === "\n") keys.push("enter");
    else if (char === " ") keys.push("space");
    else if (char === "a" || char === "A") keys.push("toggleAll");
    else if (char === "k" || char === "p") keys.push("up");
    else if (char === "j" || char === "n") keys.push("down");
    else keys.push("other");
    index += 1;
  }

  return keys;
}

interface Styler {
  dim: (text: string) => string;
  cyan: (text: string) => string;
  green: (text: string) => string;
  bold: (text: string) => string;
}

function styler(output: PromptOutput, env: NodeJS.ProcessEnv): Styler {
  const enabled = Boolean(output.isTTY) && !env.NO_COLOR;
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
  return {
    dim: wrap("2"),
    cyan: wrap("36"),
    green: wrap("32"),
    bold: wrap("1"),
  };
}

/** Drives one prompt to completion, restoring the terminal on every exit. */
function readKeys<T>(
  streams: PromptStreams,
  onKey: (key: Key, done: (value: T | undefined) => void) => void,
): Promise<T | undefined> {
  const { input, output } = streams;
  return new Promise<T | undefined>((resolvePromise) => {
    let settled = false;
    const listener = (chunk: string): void => {
      for (const key of decodeKeys(chunk)) {
        if (settled) return;
        onKey(key, finish);
      }
    };
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      input.off("data", listener);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW_CURSOR);
      resolvePromise(value);
    };

    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.resume();
    output.write(HIDE_CURSOR);
    input.on("data", listener);
  });
}

interface Frame {
  write: (lines: string[]) => void;
  clear: () => void;
}

function frame(output: PromptOutput): Frame {
  let rendered = 0;
  const clear = (): void => {
    if (rendered > 0) output.write(`\u001B[${rendered}A\u001B[0J`);
    rendered = 0;
  };
  return {
    clear,
    write: (lines) => {
      clear();
      output.write(`${lines.join("\n")}\n`);
      rendered = lines.length;
    },
  };
}

function padded(choices: Array<Choice<unknown>>): number {
  return choices.reduce((width, choice) => Math.max(width, choice.label.length), 0);
}

export interface ChooseManyOptions<T> {
  title: string;
  choices: Array<Choice<T>>;
  /** Values checked when the prompt opens. */
  initial: T[];
  streams?: PromptStreams;
  env?: NodeJS.ProcessEnv;
}

/**
 * Multi-select. Resolves `undefined` when the user cancels, which callers must
 * distinguish from an empty selection.
 */
export async function chooseMany<T>(
  options: ChooseManyOptions<T>,
): Promise<T[] | undefined> {
  const streams = options.streams ?? defaultStreams();
  const style = styler(streams.output, options.env ?? process.env);
  const view = frame(streams.output);
  const width = padded(options.choices);
  const selected = new Set(options.initial);
  let cursor = Math.max(
    0,
    options.choices.findIndex((choice) => selected.has(choice.value)),
  );

  const render = (): void => {
    const lines = [style.bold(options.title), ""];
    options.choices.forEach((choice, index) => {
      const active = index === cursor;
      const box = selected.has(choice.value) ? style.green("◉") : "◯";
      const label = choice.label.padEnd(width);
      const hint = choice.hint ? `  ${style.dim(choice.hint)}` : "";
      lines.push(
        ` ${active ? style.cyan("❯") : " "} ${box} ${active ? style.cyan(label) : label}${hint}`,
      );
    });
    lines.push(
      "",
      style.dim("   ↑↓ move · space toggle · a all · enter confirm · esc cancel"),
    );
    view.write(lines);
  };

  render();
  const result = await readKeys<T[]>(streams, (key, done) => {
    if (key === "abort") {
      view.clear();
      done(undefined);
      return;
    }
    if (key === "enter") {
      view.clear();
      done(options.choices.filter((c) => selected.has(c.value)).map((c) => c.value));
      return;
    }
    if (key === "up") cursor = (cursor - 1 + options.choices.length) % options.choices.length;
    else if (key === "down") cursor = (cursor + 1) % options.choices.length;
    else if (key === "space") {
      const choice = options.choices[cursor];
      if (choice) {
        if (selected.has(choice.value)) selected.delete(choice.value);
        else selected.add(choice.value);
      }
    } else if (key === "toggleAll") {
      if (selected.size === options.choices.length) selected.clear();
      else for (const choice of options.choices) selected.add(choice.value);
    } else return;
    render();
  });

  return result;
}

export interface ChooseOneOptions<T> {
  title: string;
  choices: Array<Choice<T>>;
  initial: T;
  streams?: PromptStreams;
  env?: NodeJS.ProcessEnv;
}

/** Single-select. Resolves `undefined` when the user cancels. */
export async function chooseOne<T>(
  options: ChooseOneOptions<T>,
): Promise<T | undefined> {
  const streams = options.streams ?? defaultStreams();
  const style = styler(streams.output, options.env ?? process.env);
  const view = frame(streams.output);
  const width = padded(options.choices);
  let cursor = Math.max(
    0,
    options.choices.findIndex((choice) => choice.value === options.initial),
  );

  const render = (): void => {
    const lines = [style.bold(options.title), ""];
    options.choices.forEach((choice, index) => {
      const active = index === cursor;
      const label = choice.label.padEnd(width);
      const hint = choice.hint ? `  ${style.dim(choice.hint)}` : "";
      lines.push(
        ` ${active ? style.cyan("❯") : " "} ${active ? style.green("●") : "○"} ${
          active ? style.cyan(label) : label
        }${hint}`,
      );
    });
    lines.push("", style.dim("   ↑↓ move · enter confirm · esc cancel"));
    view.write(lines);
  };

  render();
  return readKeys<T>(streams, (key, done) => {
    if (key === "abort") {
      view.clear();
      done(undefined);
      return;
    }
    if (key === "enter") {
      view.clear();
      done(options.choices[cursor]?.value);
      return;
    }
    if (key === "up") cursor = (cursor - 1 + options.choices.length) % options.choices.length;
    else if (key === "down") cursor = (cursor + 1) % options.choices.length;
    else return;
    render();
  });
}

export interface ConfirmOptions {
  title: string;
  initial?: boolean;
  streams?: PromptStreams;
  env?: NodeJS.ProcessEnv;
}

export function confirm(options: ConfirmOptions): Promise<boolean | undefined> {
  return chooseOne<boolean>({
    title: options.title,
    choices: [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ],
    initial: options.initial ?? true,
    ...(options.streams ? { streams: options.streams } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}
