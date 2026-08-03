<#
.SYNOPSIS
    Runs {{PROJECT_NAME}} workstreams in manifest order with a configurable agent.

.PARAMETER Program
    Program ID. The script reads docs/programs/{Program}-manifest.json.

.PARAMETER AgentCommand
    Agent executable or script. Defaults to PROGRAM_PIPELINE_AGENT_COMMAND.
    The agent must accept the generated prompt as its final positional argument.

.PARAMETER AgentArguments
    Optional arguments passed to the agent before the generated prompt.

.PARAMETER StartFrom
    Workstream ID, or an unambiguous ID prefix, from which to resume.

.PARAMETER DryRun
    Prints the manifest-driven execution plan without invoking the agent.

.PARAMETER SkipTests
    Instructs the agent to omit tests from the verification gate.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Program,

    [string]$AgentCommand = $env:PROGRAM_PIPELINE_AGENT_COMMAND,

    [string[]]$AgentArguments = @(),

    [string]$StartFrom = "",

    [switch]$DryRun,

    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$manifestPath = Join-Path "docs/programs" "$Program-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$workstreams = @($manifest.workstreams | ForEach-Object {
    [pscustomobject]@{
        id = [string]$_.id
        file = [string]$_.taskFile
        name = [string]$_.name
        dependencies = @($_.dependencies | ForEach-Object { [string]$_ })
    }
})

if ($workstreams.Count -eq 0) {
    throw "Manifest contains no workstreams: $manifestPath"
}

# Stable topological sort: preserve manifest order whenever multiple
# workstreams are ready, while always placing dependencies first.
$orderedWorkstreams = @()
$remainingWorkstreams = @($workstreams)
while ($remainingWorkstreams.Count -gt 0) {
    $completedIds = @($orderedWorkstreams | ForEach-Object { $_.id })
    $ready = @(
        $remainingWorkstreams | Where-Object {
            $unmet = @($_.dependencies | Where-Object { $_ -notin $completedIds })
            $unmet.Count -eq 0
        }
    )
    if ($ready.Count -eq 0) {
        $blocked = $remainingWorkstreams.id -join ", "
        throw "Cannot resolve workstream dependency order. Check unknown dependencies or cycles among: $blocked"
    }

    $next = $ready[0]
    $orderedWorkstreams += $next
    $remainingWorkstreams = @(
        $remainingWorkstreams | Where-Object { $_.id -ne $next.id }
    )
}
$workstreams = @($orderedWorkstreams)

$startIndex = 0
if ($StartFrom) {
    $matches = @(
        for ($i = 0; $i -lt $workstreams.Count; $i++) {
            if ($workstreams[$i].id.StartsWith($StartFrom, [System.StringComparison]::OrdinalIgnoreCase)) {
                $i
            }
        }
    )

    if ($matches.Count -eq 0) {
        throw "No workstream ID starts with '$StartFrom'."
    }
    if ($matches.Count -gt 1) {
        throw "Workstream prefix '$StartFrom' is ambiguous."
    }
    $startIndex = $matches[0]
}

$programName = if ($manifest.program -and $manifest.program.name) {
    [string]$manifest.program.name
} else {
    $Program
}

$logDir = "build-logs"
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  $programName - Automated Build" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Program     : $Program"
Write-Host "  Workstreams : $($startIndex + 1) to $($workstreams.Count) of $($workstreams.Count)"
Write-Host "  Start from  : $($workstreams[$startIndex].id) - $($workstreams[$startIndex].name)"
Write-Host "  Log dir     : $logDir/"
Write-Host ""

if ($DryRun) {
    Write-Host "--- DRY RUN ---" -ForegroundColor Yellow
    for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
        $workstream = $workstreams[$i]
        Write-Host "  [$($i + 1)] $($workstream.id) - $($workstream.name)"
        Write-Host "       Spec: $($workstream.file)" -ForegroundColor Gray
    }
    exit 0
}

if ([string]::IsNullOrWhiteSpace($AgentCommand)) {
    throw "Provide -AgentCommand or set PROGRAM_PIPELINE_AGENT_COMMAND."
}

$totalTimer = [System.Diagnostics.Stopwatch]::StartNew()

for ($i = $startIndex; $i -lt $workstreams.Count; $i++) {
    $workstream = $workstreams[$i]
    $logFile = Join-Path $logDir "$Program-$($workstream.id).log"
    $workstreamTimer = [System.Diagnostics.Stopwatch]::StartNew()
    $testInstruction = if ($SkipTests) {
        "Skip tests, but still run the build, type-check, and lint commands that are configured."
    } else {
        "Run the project's test command and fix every failure."
    }

    $prompt = @"
You are implementing workstream '$($workstream.id): $($workstream.name)'.

STEP 1 - CONTEXT:
- Read the workstream spec: $($workstream.file)
- Read AGENTS.md for agent directives and coding conventions.
- Read every additional file listed in the spec's "Context Files" section.

STEP 2 - IMPLEMENT:
- Implement every requirement and every file listed in "Files Touched".
- Follow the spec's implementation steps.
- Write the tests described by the spec.
- Do not commit changes, bypass hooks, or weaken verification.

STEP 3 - VERIFY (mandatory):
- Run the project's configured build command.
- Run the project's configured type-check command.
- Run the project's configured lint command when one exists.
- $testInstruction
- Fix all errors and repeat verification until every required command exits successfully.

RULES:
- Read each file before editing and re-read it after editing.
- Create files marked (NEW); edit existing files marked (MODIFY).
- Replace any prior-workstream stub with the complete implementation.
- Stop and report a blocker rather than silently skipping a requirement.
"@

    Write-Host ""
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] === $($workstream.id): $($workstream.name) ($($i + 1)/$($workstreams.Count)) ===" -ForegroundColor Cyan
    Write-Host "  Invoking agent: $AgentCommand" -ForegroundColor Gray

    $global:LASTEXITCODE = 0
    & $AgentCommand @AgentArguments $prompt 2>&1 | Tee-Object -FilePath $logFile
    $agentExitCode = $LASTEXITCODE

    if ($agentExitCode -ne 0) {
        Write-Host "  Agent failed with code $agentExitCode; attempting one focused recovery..." -ForegroundColor Yellow
        $fixPrompt = @"
Workstream '$($workstream.id): $($workstream.name)' failed verification.

- Read the workstream spec: $($workstream.file)
- Read the failure log: $logFile
- Fix only the implementation and tests required by this workstream.
- Run the project's build, type-check, lint, and test commands.
- Repeat until every required command exits successfully.
- Do not commit changes, bypass hooks, or weaken verification.
"@
        $global:LASTEXITCODE = 0
        & $AgentCommand @AgentArguments $fixPrompt 2>&1 |
            Tee-Object -Append -FilePath $logFile
        $recoveryExitCode = $LASTEXITCODE
        if ($recoveryExitCode -ne 0) {
            Write-Error "Agent failed for workstream '$($workstream.id)' after one recovery attempt. See $logFile."
            exit $recoveryExitCode
        }
    }

    $workstreamTimer.Stop()
    Write-Host "  Completed in $([math]::Round($workstreamTimer.Elapsed.TotalMinutes, 1)) minutes." -ForegroundColor Green
}

$totalTimer.Stop()
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  ALL WORKSTREAMS COMPLETE" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Total: $([math]::Round($totalTimer.Elapsed.TotalMinutes, 1)) minutes"
Write-Host "  Next: inspect the build and update the as-built snapshot."
