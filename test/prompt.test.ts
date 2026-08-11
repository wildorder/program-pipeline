import { describe, expect, it } from "vitest";
import {
  chooseMany,
  chooseOne,
  confirm,
  isInteractive,
  type PromptStreams,
} from "../src/prompt.js";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";

class FakeInput {
  isTTY = true;
  raw = false;
  paused = true;
  private listener: ((chunk: string) => void) | undefined;

  setRawMode(mode: boolean): this {
    this.raw = mode;
    return this;
  }
  setEncoding(): void {}
  on(_event: "data", listener: (chunk: string) => void): void {
    this.listener = listener;
  }
  off(): void {
    this.listener = undefined;
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  send(chunk: string): void {
    this.listener?.(chunk);
  }
  get listening(): boolean {
    return this.listener !== undefined;
  }
}

class FakeOutput {
  isTTY = false;
  chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  get text(): string {
    return this.chunks.join("");
  }
}

function streams(): { io: PromptStreams; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  return { io: { input, output }, input, output };
}

const CHOICES = [
  { value: "claude" as const, label: "Claude Code", hint: "~/.claude/skills" },
  { value: "cursor" as const, label: "Cursor", hint: "~/.cursor/skills" },
  { value: "gemini" as const, label: "Gemini CLI", hint: "not detected" },
];

describe("chooseMany", () => {
  it("returns the pre-selected values when the user just confirms", async () => {
    const { io, input } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude", "cursor"],
      streams: io,
      env: {},
    });
    input.send(ENTER);

    expect(await promise).toEqual(["claude", "cursor"]);
  });

  it("toggles the row under the cursor with space", async () => {
    const { io, input } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude"],
      streams: io,
      env: {},
    });
    input.send(DOWN);
    input.send(" ");
    input.send(ENTER);

    expect(await promise).toEqual(["claude", "cursor"]);
  });

  it("toggles a selected row back off", async () => {
    const { io, input } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude", "cursor"],
      streams: io,
      env: {},
    });
    // The cursor opens on the first selected row.
    input.send(" ");
    input.send(ENTER);

    expect(await promise).toEqual(["cursor"]);
  });

  it("wraps the cursor past both ends of the list", async () => {
    const { io, input } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: [],
      streams: io,
      env: {},
    });
    input.send(UP);
    input.send(" ");
    input.send(DOWN);
    input.send(" ");
    input.send(ENTER);

    expect(await promise).toEqual(["claude", "gemini"]);
  });

  it("selects and clears everything with a", async () => {
    const { io, input } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude"],
      streams: io,
      env: {},
    });
    input.send("a");
    input.send(ENTER);

    expect(await promise).toEqual(["claude", "cursor", "gemini"]);

    const second = streams();
    const cleared = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude", "cursor", "gemini"],
      streams: second.io,
      env: {},
    });
    second.input.send("a");
    second.input.send(ENTER);

    expect(await cleared).toEqual([]);
  });

  it("distinguishes cancelling from selecting nothing", async () => {
    const { io, input } = streams();
    const cancelled = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude"],
      streams: io,
      env: {},
    });
    input.send(CTRL_C);
    expect(await cancelled).toBeUndefined();

    const second = streams();
    const empty = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: [],
      streams: second.io,
      env: {},
    });
    second.input.send(ENTER);
    expect(await empty).toEqual([]);
  });

  it("cancels on a bare escape but not on an escape sequence", async () => {
    const { io, input } = streams();
    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: ["claude"],
      streams: io,
      env: {},
    });
    // A function key must not read as a cancel.
    input.send(`${ESC}[3~`);
    input.send(ESC);

    expect(await promise).toBeUndefined();
  });

  it("restores the terminal and stops listening on every exit", async () => {
    const { io, input, output } = streams();

    const promise = chooseMany({
      title: "Where?",
      choices: CHOICES,
      initial: [],
      streams: io,
      env: {},
    });
    expect(input.raw).toBe(true);
    input.send(ENTER);
    await promise;

    expect(input.raw).toBe(false);
    expect(input.paused).toBe(true);
    expect(input.listening).toBe(false);
    expect(output.text).toContain("[?25h");
  });

  it("renders each label with its hint and omits colour without a TTY", async () => {
    const { io, input, output } = streams();

    const promise = chooseMany({
      title: "Where should the workflow skills go?",
      choices: CHOICES,
      initial: ["claude"],
      streams: io,
      env: {},
    });
    input.send(ENTER);
    await promise;

    expect(output.text).toContain("Where should the workflow skills go?");
    expect(output.text).toContain("Claude Code");
    expect(output.text).toContain("~/.cursor/skills");
    expect(output.text).toContain("not detected");
    expect(output.text).not.toContain(`${ESC}[36m`);
  });
});

describe("chooseOne", () => {
  it("returns the row under the cursor", async () => {
    const { io, input } = streams();

    const promise = chooseOne({
      title: "Scope?",
      choices: [
        { value: "user" as const, label: "This machine" },
        { value: "project" as const, label: "This project" },
      ],
      initial: "user",
      streams: io,
      env: {},
    });
    input.send(DOWN);
    input.send(ENTER);

    expect(await promise).toBe("project");
  });
});

describe("confirm", () => {
  it("defaults to yes and returns undefined when cancelled", async () => {
    const { io, input } = streams();
    const yes = confirm({ title: "Remove them?", streams: io, env: {} });
    input.send(ENTER);
    expect(await yes).toBe(true);

    const second = streams();
    const cancelled = confirm({ title: "Remove them?", streams: second.io, env: {} });
    second.input.send(CTRL_C);
    expect(await cancelled).toBeUndefined();
  });
});

describe("isInteractive", () => {
  it("requires a TTY on both ends and no CI marker", () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    output.isTTY = true;

    expect(isInteractive({ input, output }, {})).toBe(true);
    expect(isInteractive({ input, output }, { CI: "true" })).toBe(false);

    output.isTTY = false;
    expect(isInteractive({ input, output }, {})).toBe(false);

    output.isTTY = true;
    input.isTTY = false;
    expect(isInteractive({ input, output }, {})).toBe(false);
  });
});
