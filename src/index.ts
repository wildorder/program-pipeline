export {
  auditPlan,
  type CriterionAssessment,
  type PlanAuditOptions,
  type PlanAuditResult,
  type PlanClassAnalysis,
} from "./plan-audit.js";
export {
  defaultAgentRunner,
  defaultVerifyRunner,
  describeAgent,
  resolveAgent,
  resolveAuthorAgent,
  resolveRecoveryAgent,
  resolveValidatorAgent,
  runProcess,
  sanitizedEnvironment,
  tail,
  type AgentInvocation,
  type AgentRunner,
  type CommandResult,
  type ResolvedAuthorAgent,
  type ResolvedRecoveryAgent,
  type VerifyRunner,
} from "./agent-runner.js";
export {
  extractSummary,
  resolveSummary,
  summaryContract,
  summaryEventData,
  summaryLine,
  type AgentSummary,
} from "./agent-summary.js";
export {
  archivePathFor,
  snapshotPathFor,
  updateAsBuilt,
  type AsBuiltOptions,
  type AsBuiltResult,
} from "./as-built.js";
export {
  parseStage,
  runProgram,
  RUN_STAGES,
  stagesFor,
  type RunOutcome,
  type RunProgramOptions,
  type RunProgramResult,
  type RunStage,
  type RunStageResult,
} from "./run-program.js";
export {
  EXECUTION_MODES,
  parseExecutionMode,
  readProgramExecutionMode,
  type ExecutionMode,
  type ProgramExecutionMode,
} from "./execution-mode.js";
export {
  renderReviewReport,
  reportPathFor,
  reviewProgram,
  type ReviewProgramOptions,
  type ReviewProgramResult,
} from "./review-program.js";
export {
  composeAuthorBrief,
  type AuthorBriefSources,
  type AuthorTarget,
  type RosterEntry,
  type WorkstreamScope,
} from "./author-brief.js";
export {
  authorWorkstreams,
  fitDependencySpecs,
  parseDeclaration,
  readScope,
  type AuthorDeclaration,
  type AuthorOutcome,
  type AuthorProgramOptions,
  type AuthorProgramResult,
  type AuthorWorkstreamOutcome,
  type ReconciliationRecord,
} from "./author-workstreams.js";
export {
  describeEdges,
  reconcileDependencies,
  writeMergedDependencies,
  type DeclaredEdges,
  type DependencyEdge,
  type ReconcileInput,
  type ReconcileResult,
  type UnmetRequirement,
} from "./reconcile-dependencies.js";
export {
  buildProgram,
  type BuildOutcome,
  type BuildProgramOptions,
  type BuildProgramResult,
  type PlanEntry,
  type TestCritiqueRecord,
  type WorkstreamOutcome,
} from "./build-program.js";
export {
  collectCriteria,
  criteriaGateFailure,
  criteriaHash,
  documentPathFor,
  manifestPathFor,
  renderCriteriaDocument,
  reviewCriteria,
  type CriteriaApproval,
  type CriteriaOptions,
  type CriteriaOutcome,
  type CriteriaResult,
  type CriteriaStatus,
  type WorkstreamCriteria,
} from "./criteria.js";
export {
  CONVERGENCE_RECEIPT_VERSION,
  convergenceInputHash,
  convergenceReceiptPath,
  inspectConvergenceReceipt,
  writeConvergenceReceipt,
  type ConvergenceReceipt,
  type ConvergenceReceiptStatus,
} from "./convergence-receipt.js";
export {
  REPLAN_REPORT_VERSION,
  clearReplanReport,
  replanInputHash,
  replanReportPath,
  replanHistoryDir,
  writeReplanReport,
  type ReplanReport,
  type ReplanReportOutcome,
  type ReplanAttempt,
  type ReplanResolutionProof,
} from "./replan-report.js";
export {
  LEGACY_PLAN_GENERATION,
  PLAN_GENERATION_MARKER,
  atomicWriteText,
  legacyGenerationFingerprint,
  readPlanGeneration,
  specGeneration,
  stampSpecGeneration,
} from "./plan-generation.js";
export { ignoredArtifacts } from "./artifact-status.js";
export {
  replanProgram,
  type ReplanProgramOptions,
  type ReplanProgramResult,
} from "./replan-program.js";
export {
  addDevDependencyCommand,
  detectPackageManager,
  isPnpmWorkspaceRoot,
  PACKAGE_MANAGERS,
  parsePackageManager,
  type PackageManager,
} from "./detect-package-manager.js";
export {
  findCycles,
  stableTopologicalOrder,
  topologicalLevels,
  type GraphNode,
} from "./graph.js";
export {
  loadPipelineConfig,
  pipelineConfigSchema,
  PIPELINE_CONFIG_FILE,
  type AgentConfig,
  type PipelineConfig,
} from "./pipeline-config.js";
export {
  assessRepositoryExecutionFit,
  declaredTouchedFiles,
  DEFAULT_EXECUTION_FIT_POLICY,
  estimateExecutionFit,
  type ExecutionFitApproval,
  type ExecutionFitClassification,
  type ExecutionFitEstimate,
  type ExecutionFitInput,
  type ExecutionFitPolicy,
  type ExecutionFitTextReader,
  type DeclaredTouchedFile,
  type RepositoryExecutionFitAssessment,
  type RepositoryExecutionFitComponents,
  type RepositoryExecutionFitInput,
} from "./execution-fit.js";
export {
  initProject,
  initOptionsSchema,
  type InitOptions,
  type InitResult,
} from "./init-project.js";
export {
  GITHUB_WORKFLOW_PATH,
  initCiOptionsSchema,
  initGitHubCi,
  renderGitHubWorkflow,
  type CiFileSystem,
  type GitHubWorkflowOptions,
  type InitCiOptions,
  type InitCiResult,
  type KnownAgentCli,
} from "./init-ci.js";
export {
  ALL_TARGETS,
  DEFAULT_TARGETS,
  detectTargets,
  doctor,
  findProjectCopies,
  installSkills,
  overrideEnvName,
  parseRootOverrides,
  parseTargets,
  RETIRED_WORKFLOWS,
  WORKFLOWS,
  type DefinitionWarning,
  type DetectedTarget,
  type InstallScope,
  type InstallSkillsOptions,
  type InstallSkillsResult,
  type KnownWorkflow,
  type ProjectCopies,
  type RetiredWorkflow,
  type RootSource,
  type SkillTarget,
  type Workflow,
} from "./install-skills.js";
export {
  loadInstallPrefs,
  saveInstallPrefs,
  PREFS_PATH,
  type InstallPrefs,
  type PreferredScope,
} from "./install-prefs.js";
export {
  installArgv,
  planSkillInstall,
  scopesFor,
  type InstallArgvOptions,
  type SkillPlan,
  type SkillPlanOptions,
} from "./install-wizard.js";
export {
  chooseMany,
  chooseOne,
  confirm,
  defaultStreams,
  isInteractive,
  type Choice,
  type PromptStreams,
} from "./prompt.js";
export {
  scanRoots,
  type ResolveContext,
  type ScanRoot,
} from "./skill-roots.js";
export {
  at,
  because,
  countBySeverity,
  fingerprint,
  FINDING_CATEGORIES,
  haltsConvergence,
  isGateFailing,
  measured,
  sortBySeverity,
  type Evidence,
  type ClassAnalysis,
  type Finding,
  type FindingCategory,
  type Severity,
} from "./findings.js";
export {
  applySeverityPolicy,
  citesCause,
  summarizePolicy,
  type PolicySummary,
} from "./severity-policy.js";
export {
  extractJson,
  hasArrayKey,
  parseCriticFindings,
  parseCriticReply,
  parseWriterVerdict,
  validateLoop,
  type CriticReply,
  type CriticProtocolFailure,
  type CriticProtocolFailureKind,
  type Disagreement,
  type LoopOutcome,
  type ResolvedAgents,
  type RoundRecord,
  type ValidateLoopOptions,
  type ValidateLoopResult,
  type WriterVerdict,
} from "./validate-loop.js";
export {
  composeCriticBrief,
  composeCriticCorrectionBrief,
  composeWriterBrief,
  loadBriefSources,
  type BriefSources,
  type RoundContext,
} from "./validator-brief.js";
export {
  SPEC_CONTRACT,
  validateWorkstreams,
  type CoverageEntry,
  type ValidationReport,
} from "./validate.js";
