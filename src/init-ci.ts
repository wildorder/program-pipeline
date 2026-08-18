import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  pipelineConfigSchema,
  PIPELINE_CONFIG_FILE,
  type AgentConfig,
  type PipelineConfig,
} from "./pipeline-config.js";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/program-pipeline.yml";

export const initCiOptionsSchema = z.object({
  cwd: z.string().min(1),
  force: z.boolean().default(false),
  setupCommand: z.string().min(1).optional(),
});

export type InitCiOptions = z.infer<typeof initCiOptionsSchema>;

export interface InitCiResult {
  path: string;
  result: "created" | "updated" | "skipped";
  agents: string[];
  warnings: string[];
  requiredSecrets: string[];
  requiredVariables: string[];
}

export interface CiFileSystem {
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<void>;
}

const defaultFileSystem: CiFileSystem = {
  access: async (path) => access(path),
  mkdir: async (path, options) => mkdir(path, options),
  readFile: async (path, encoding) => readFile(path, encoding),
  writeFile: async (path, content, encoding) =>
    writeFile(path, content, encoding),
};

export interface KnownAgentCli {
  command: string;
  packageName: string;
  versionVariable: string;
}

const KNOWN_AGENT_CLIS: Record<string, KnownAgentCli> = {
  cline: {
    command: "cline",
    packageName: "cline",
    versionVariable: "CLINE_VERSION",
  },
  claude: {
    command: "claude",
    packageName: "@anthropic-ai/claude-code",
    versionVariable: "CLAUDE_CODE_VERSION",
  },
  codex: {
    command: "codex",
    packageName: "@openai/codex",
    versionVariable: "CODEX_VERSION",
  },
};

async function exists(fs: CiFileSystem, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readConfig(
  fs: CiFileSystem,
  root: string,
): Promise<PipelineConfig> {
  const path = join(root, PIPELINE_CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    throw new Error(
      `${PIPELINE_CONFIG_FILE} not found in ${root}; run program-pipeline init first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${PIPELINE_CONFIG_FILE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const result = pipelineConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "/"} ${issue.message}`)
      .join("; ");
    throw new Error(`${PIPELINE_CONFIG_FILE} is invalid: ${issues}`);
  }
  return result.data;
}

function normalizedCommand(command: string): string {
  return basename(command).replace(/\.(?:cmd|exe)$/iu, "").toLowerCase();
}

function configuredCommands(config: PipelineConfig): string[] {
  return [
    config.agent,
    config.recoveryAgent,
    config.authorAgent,
    config.validatorAgent,
  ]
    .filter((agent): agent is AgentConfig => agent !== undefined)
    .map(({ command }) => normalizedCommand(command))
    .filter((command, index, commands) => commands.indexOf(command) === index);
}

async function detectedSetupCommand(
  fs: CiFileSystem,
  root: string,
): Promise<{ command?: string; setupBun: boolean }> {
  if (!(await exists(fs, join(root, "package.json")))) {
    return { setupBun: false };
  }
  if (await exists(fs, join(root, "pnpm-lock.yaml"))) {
    return {
      command: "corepack enable\npnpm install --frozen-lockfile",
      setupBun: false,
    };
  }
  if (await exists(fs, join(root, "yarn.lock"))) {
    return {
      command: "corepack enable\nyarn install --immutable",
      setupBun: false,
    };
  }
  if (
    (await exists(fs, join(root, "bun.lock"))) ||
    (await exists(fs, join(root, "bun.lockb")))
  ) {
    return { command: "bun install --frozen-lockfile", setupBun: true };
  }
  if (await exists(fs, join(root, "package-lock.json"))) {
    return { command: "npm ci", setupBun: false };
  }
  return { command: "npm install --no-package-lock", setupBun: false };
}

function indentBlock(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split(/\r?\n/u)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export interface GitHubWorkflowOptions {
  agentClis: KnownAgentCli[];
  pipelineVersion: string;
  projectSetupCommand?: string;
  setupBun?: boolean;
}

/** Render the deterministic workflow installed by `program-pipeline ci init`. */
export function renderGitHubWorkflow(options: GitHubWorkflowOptions): string {
  const installVariables = options.agentClis
    .map(
      ({ versionVariable }) =>
        `          ${versionVariable}: \${{ vars.${versionVariable} || 'latest' }}`,
    )
    .join("\n");
  const installPackages = options.agentClis
    .map(
      ({ packageName, versionVariable }) =>
        `"${packageName}@$${versionVariable}"`,
    )
    .join(" ");
  const installAgents =
    options.agentClis.length === 0
      ? ""
      : `\n      - name: Install configured agent CLIs\n        env:\n${installVariables}\n        run: npm install --global ${installPackages}\n`;
  const setupBun = options.setupBun
    ? "\n      - name: Set up Bun\n        uses: oven-sh/setup-bun@v2\n"
    : "";
  const projectSetup = options.projectSetupCommand
    ? `\n      - name: Install project dependencies\n        run: |\n${indentBlock(options.projectSetupCommand, 10)}\n`
    : "";

  return `# Generated by @wildorder/program-pipeline. Re-run with --force to replace.
name: Program Pipeline

on:
  workflow_dispatch:
    inputs:
      program_id:
        description: Program ID (lowercase kebab-case)
        required: true
        type: string
      from:
        description: Optional first stage
        required: false
        type: string
      to:
        description: Optional last stage
        required: false
        type: string
      review:
        description: Include the advisory architecture review
        required: false
        default: false
        type: boolean
      approve_criteria:
        description: Approve current criteria before resuming
        required: false
        default: false
        type: boolean

permissions:
  contents: write
  pull-requests: write
  id-token: write

concurrency:
  group: program-pipeline-\${{ github.repository }}-\${{ inputs.program_id }}
  cancel-in-progress: false

jobs:
  run:
    name: Run \${{ inputs.program_id }}
    runs-on: ubuntu-latest
    timeout-minutes: 350
    env:
      PROGRAM_ID: \${{ inputs.program_id }}
      PIPELINE_BRANCH: program/\${{ inputs.program_id }}
      BASE_BRANCH: \${{ github.event.repository.default_branch }}
      AWS_ROLE_TO_ASSUME: \${{ vars.AWS_ROLE_TO_ASSUME }}
      AWS_REGION: \${{ vars.AWS_REGION || 'us-east-1' }}
      CLAUDE_CODE_USE_BEDROCK: \${{ vars.CLAUDE_CODE_USE_BEDROCK }}
      ANTHROPIC_MODEL: \${{ vars.ANTHROPIC_MODEL }}

    steps:
      - name: Check out base repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Validate inputs and select program branch
        shell: bash
        run: |
          if [[ ! "$PROGRAM_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
            echo "program_id must be lowercase kebab-case" >&2
            exit 1
          fi
          for stage in "\${{ inputs.from }}" "\${{ inputs.to }}"; do
            if [[ -n "$stage" && ! "$stage" =~ ^(author|validate|converge|review|criteria|build|as-built)$ ]]; then
              echo "invalid stage: $stage" >&2
              exit 1
            fi
          done
          git fetch origin "$PIPELINE_BRANCH" || true
          if git show-ref --verify --quiet "refs/remotes/origin/$PIPELINE_BRANCH"; then
            git switch --force-create "$PIPELINE_BRANCH" "origin/$PIPELINE_BRANCH"
          else
            git switch --create "$PIPELINE_BRANCH"
          fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
${setupBun}${projectSetup}${installAgents}
      - name: Install pinned Program Pipeline CLI
        run: npm install --global "@wildorder/program-pipeline@${options.pipelineVersion}"

      - name: Configure temporary AWS credentials
        if: env.AWS_ROLE_TO_ASSUME != ''
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ env.AWS_ROLE_TO_ASSUME }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Approve acceptance criteria
        if: inputs.approve_criteria
        run: program-pipeline criteria "$PROGRAM_ID" --approve

      - name: Run program pipeline
        id: pipeline
        shell: bash
        env:
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          args=(run "$PROGRAM_ID")
          if [[ -n "\${{ inputs.from }}" ]]; then
            args+=(--from "\${{ inputs.from }}")
          elif [[ "\${{ inputs.approve_criteria }}" == "true" ]]; then
            args+=(--from criteria)
          fi
          if [[ -n "\${{ inputs.to }}" ]]; then args+=(--to "\${{ inputs.to }}"); fi
          if [[ "\${{ inputs.review }}" == "true" ]]; then args+=(--review); fi

          set +e
          program-pipeline "\${args[@]}" 2>&1 | tee program-pipeline-run.log
          code=\${PIPESTATUS[0]}
          set -e
          echo "exit_code=$code" >> "$GITHUB_OUTPUT"

      - name: Preserve uncommitted failure state
        if: always()
        shell: bash
        run: |
          mkdir -p build-logs
          git diff --binary HEAD > "build-logs/$PROGRAM_ID-uncommitted.patch"

      - name: Push pipeline checkpoints
        id: checkpoint
        if: always()
        shell: bash
        run: |
          if git diff --quiet "origin/$BASE_BRANCH...HEAD"; then
            echo "has_changes=false" >> "$GITHUB_OUTPUT"
            echo "No committed pipeline changes to push."
            exit 0
          fi
          git push origin "HEAD:$PIPELINE_BRANCH"
          echo "has_changes=true" >> "$GITHUB_OUTPUT"

      - name: Create or update draft pull request
        if: always() && steps.checkpoint.outputs.has_changes == 'true'
        env:
          GH_TOKEN: \${{ github.token }}
        shell: bash
        run: |
          number="$(gh pr list --head "$PIPELINE_BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty')"
          if [[ -z "$number" ]]; then
            gh pr create --draft --base "$BASE_BRANCH" --head "$PIPELINE_BRANCH" \\
              --title "Program: $PROGRAM_ID" \\
              --body "Automated program-pipeline run for \`$PROGRAM_ID\`. Review all generated specifications, implementation commits, and acceptance criteria before merging."
          else
            echo "updated existing PR #$number"
          fi

      - name: Upload pipeline logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: program-pipeline-\${{ inputs.program_id }}-\${{ github.run_id }}
          path: |
            program-pipeline-run.log
            build-logs/
          if-no-files-found: warn
          retention-days: 30

      - name: Report pipeline outcome
        if: always()
        shell: bash
        run: |
          code="\${{ steps.pipeline.outputs.exit_code }}"
          if [[ "$code" == "2" ]]; then
            echo "Pipeline stopped for acceptance-criteria approval." >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          if [[ -z "$code" || "$code" != "0" ]]; then
            echo "Pipeline failed with exit code \${code:-unknown}." >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
          echo "Pipeline completed successfully." >> "$GITHUB_STEP_SUMMARY"
`;
}

export async function initGitHubCi(
  input: InitCiOptions,
  fs: CiFileSystem = defaultFileSystem,
): Promise<InitCiResult> {
  const options = initCiOptionsSchema.parse(input);
  const root = resolve(options.cwd);
  const config = await readConfig(fs, root);
  const commands = configuredCommands(config);
  const warnings: string[] = [];
  const agentClis: KnownAgentCli[] = [];

  for (const command of commands) {
    const known = KNOWN_AGENT_CLIS[command];
    if (known) agentClis.push(known);
    else {
      warnings.push(
        `Agent command "${command}" is not installed by the generated workflow; add its setup step manually.`,
      );
    }
  }
  if (!config.agent) warnings.push("No build agent is configured.");
  if (!config.authorAgent) warnings.push("No author agent is configured.");
  if (!config.validatorAgent) warnings.push("No validator agent is configured.");

  const detected = await detectedSetupCommand(fs, root);
  const projectSetupCommand = options.setupCommand ?? detected.command;
  const content = renderGitHubWorkflow({
    agentClis,
    pipelineVersion: config.pipelineVersion,
    ...(projectSetupCommand ? { projectSetupCommand } : {}),
    setupBun: options.setupCommand === undefined && detected.setupBun,
  });
  const destination = join(root, GITHUB_WORKFLOW_PATH);
  const present = await exists(fs, destination);
  const versionVariables = agentClis.map(
    ({ versionVariable }) => versionVariable,
  );
  if (present && !options.force) {
    return {
      path: GITHUB_WORKFLOW_PATH,
      result: "skipped",
      agents: commands,
      warnings: [
        ...warnings,
        `${GITHUB_WORKFLOW_PATH} already exists; re-run with --force to replace it.`,
      ],
      requiredSecrets: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      requiredVariables: [
        "AWS_ROLE_TO_ASSUME",
        "AWS_REGION",
        "CLAUDE_CODE_USE_BEDROCK",
        "ANTHROPIC_MODEL",
        ...versionVariables,
      ],
    };
  }

  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.writeFile(destination, content, "utf8");
  return {
    path: GITHUB_WORKFLOW_PATH,
    result: present ? "updated" : "created",
    agents: commands,
    warnings,
    requiredSecrets: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    requiredVariables: [
      "AWS_ROLE_TO_ASSUME",
      "AWS_REGION",
      "CLAUDE_CODE_USE_BEDROCK",
      "ANTHROPIC_MODEL",
      ...versionVariables,
    ],
  };
}
