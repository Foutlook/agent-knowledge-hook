$AgentKnowledgeRoot = Split-Path -Parent $PSScriptRoot
$ToolRepoRoot = Split-Path -Parent $AgentKnowledgeRoot
$WorkspaceRoot = Split-Path -Parent $ToolRepoRoot
$AgentKnowledgeCli = Join-Path $PSScriptRoot "agent-knowledge.js"
$AkHelpFile = Join-Path $AgentKnowledgeRoot "help\ak.zh-CN.txt"
$CommandContractFile = Join-Path $AgentKnowledgeRoot "command-contract.json"

function Assert-CommandContractText {
  param(
    $Value,
    [string] $Context,
    [bool] $AllowEmpty = $false
  )

  if ($Value -isnot [string]) {
    throw "$Context must be a string"
  }
  if (-not $AllowEmpty -and $Value.Length -eq 0) {
    throw "$Context must not be empty"
  }
  if ($Value -match '[\r\n`]') {
    throw "$Context must be single-line text without backticks"
  }
}

function Assert-CommandContractName {
  param(
    [string] $Value,
    [string] $Context
  )

  if ($Value -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
    throw "$Context must use lowercase letters, digits, and single hyphen separators"
  }
}

function Assert-CommandContractCollection {
  param(
    $Commands,
    [string] $CollectionName,
    [bool] $IsAkCommand
  )

  if ($Commands -isnot [System.Array]) {
    throw "Command contract field $CollectionName must be an array"
  }

  $ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  for ($index = 0; $index -lt $Commands.Count; $index++) {
    $command = $Commands[$index]
    $context = "${CollectionName}[$index]"
    if ($null -eq $command -or $command -isnot [System.Management.Automation.PSCustomObject]) {
      throw "$context must be an object"
    }

    foreach ($field in @("id", "name", "args", "summary")) {
      $allowEmpty = $field -eq "args"
      Assert-CommandContractText -Value $command.$field -Context "$context.$field" -AllowEmpty $allowEmpty
    }
    Assert-CommandContractName -Value $command.name -Context "$context.name"

    if (@("never", "always", "conditional") -cnotcontains $command.writeMode) {
      throw "$context.writeMode must be never, always, or conditional"
    }
    if ($command.jsonOutput -isnot [bool]) {
      throw "$context.jsonOutput must be boolean"
    }
    if (-not $ids.Add($command.id)) {
      throw "$context.id duplicates an existing id: $($command.id)"
    }
    if (-not $names.Add($command.name)) {
      throw "$context.name duplicates an existing command name: $($command.name)"
    }

    if ($IsAkCommand) {
      if ($command.aliases -isnot [System.Array]) {
        throw "$context.aliases must be an array"
      }
      for ($aliasIndex = 0; $aliasIndex -lt $command.aliases.Count; $aliasIndex++) {
        $aliasContext = "$context.aliases[$aliasIndex]"
        Assert-CommandContractText -Value $command.aliases[$aliasIndex] -Context $aliasContext
        Assert-CommandContractName -Value $command.aliases[$aliasIndex] -Context $aliasContext
      }
      Assert-CommandContractText -Value $command.mapsTo -Context "$context.mapsTo"
    }
  }
}

function Assert-CommandContract {
  param(
    $Contract
  )

  if ($null -eq $Contract -or $Contract -isnot [System.Management.Automation.PSCustomObject]) {
    throw "Command contract must be an object"
  }
  $versionIsNumber = $Contract.version -is [byte] -or
    $Contract.version -is [int16] -or
    $Contract.version -is [int32] -or
    $Contract.version -is [int64] -or
    $Contract.version -is [single] -or
    $Contract.version -is [double] -or
    $Contract.version -is [decimal]
  if (-not $versionIsNumber -or $Contract.version -ne 1) {
    throw "Command contract field version must strictly equal 1"
  }

  Assert-CommandContractCollection -Commands $Contract.cliCommands -CollectionName "cliCommands" -IsAkCommand $false
  Assert-CommandContractCollection -Commands $Contract.akCommands -CollectionName "akCommands" -IsAkCommand $true

  # PowerShell resolves primary commands and aliases in one namespace, so all route names must be unique.
  $names = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
  for ($index = 0; $index -lt $Contract.akCommands.Count; $index++) {
    $names.Add($Contract.akCommands[$index].name, "akCommands[$index].name")
  }
  $aliases = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::Ordinal)
  for ($commandIndex = 0; $commandIndex -lt $Contract.akCommands.Count; $commandIndex++) {
    $command = $Contract.akCommands[$commandIndex]
    for ($aliasIndex = 0; $aliasIndex -lt $command.aliases.Count; $aliasIndex++) {
      $alias = $command.aliases[$aliasIndex]
      $context = "akCommands[$commandIndex].aliases[$aliasIndex]"
      if ($names.ContainsKey($alias)) {
        throw "$context conflicts with primary command $($names[$alias]): $alias"
      }
      if ($aliases.ContainsKey($alias)) {
        throw "$context conflicts with alias $($aliases[$alias]): $alias"
      }
      $aliases.Add($alias, $context)
    }
  }

  $cliNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($command in $Contract.cliCommands) {
    [void] $cliNames.Add($command.name)
  }
  $allowedWrappers = @("wrapper:projects", "wrapper:raw")
  for ($index = 0; $index -lt $Contract.akCommands.Count; $index++) {
    $mapsTo = $Contract.akCommands[$index].mapsTo
    if (-not $cliNames.Contains($mapsTo) -and $allowedWrappers -cnotcontains $mapsTo) {
      throw "akCommands[$index].mapsTo must reference a registered CLI command or allowed wrapper: $mapsTo"
    }
  }
}

function Read-CommandContract {
  try {
    # Windows PowerShell 5.1 has an unstable default code page; decode the contract as strict UTF-8 explicitly.
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $json = [System.IO.File]::ReadAllText($CommandContractFile, $utf8)
  } catch {
    throw "Command contract must be valid UTF-8: $($_.Exception.Message)"
  }

  try {
    $contract = $json | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Command contract JSON parsing failed: $($_.Exception.Message)"
  }
  Assert-CommandContract $contract
  return $contract
}

function Resolve-KnowledgeRoot {
  if ($env:AGENT_KNOWLEDGE_ROOT) {
    return $env:AGENT_KNOWLEDGE_ROOT
  }

  $siblingKnowledgeRoot = Join-Path $WorkspaceRoot "team-agent-knowledge"
  if (Test-Path $siblingKnowledgeRoot) {
    return $siblingKnowledgeRoot
  }

  return $AgentKnowledgeRoot
}

function Write-Usage {
  $contract = Read-CommandContract
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("ak: agent-knowledge short commands")
  $lines.Add("")
  $lines.Add("Commands:")
  foreach ($command in $contract.akCommands) {
    $renderedCommand = "  ak $($command.name)"
    if ($command.args) {
      $renderedCommand += " $($command.args)"
    }
    $lines.Add("$renderedCommand  $($command.summary)")
  }
  $lines -join [Environment]::NewLine
}

function Normalize-HelpTopic {
  param(
    [string] $Topic
  )

  switch ($Topic) {
    "before" { return "task" }
    "before-task" { return "task" }
    "s" { return "search" }
    "stale" { return "check" }
    default { return $Topic }
  }
}

function Write-AkHelp {
  param(
    [string] $Topic
  )

  if (-not (Test-Path $AkHelpFile)) {
    Write-Usage
    return
  }

  $lines = Get-Content -Encoding UTF8 $AkHelpFile
  $normalizedTopic = Normalize-HelpTopic $Topic

  if (-not $normalizedTopic) {
    $lines | ForEach-Object { Write-Output $_ }
    return
  }

  $sectionHeader = "## $normalizedTopic"
  $capturing = $false
  $sectionLines = New-Object System.Collections.Generic.List[string]

  foreach ($line in $lines) {
    if ($line -eq $sectionHeader) {
      $capturing = $true
    } elseif ($capturing -and $line.StartsWith("## ")) {
      break
    }

    if ($capturing) {
      $sectionLines.Add($line)
    }
  }

  if ($sectionLines.Count -eq 0) {
    Write-Output "Help topic not found: $Topic"
    Write-Output ""
    $lines | ForEach-Object { Write-Output $_ }
    return
  }

  $sectionLines | ForEach-Object { Write-Output $_ }
}

function Invoke-AgentKnowledge {
  param(
    [string[]] $CliArgs
  )

  $knowledgeRoot = Resolve-KnowledgeRoot
  & node $AgentKnowledgeCli @CliArgs --knowledge-root $knowledgeRoot
  exit $LASTEXITCODE
}

function Get-ProjectKnowledgeFile {
  param(
    [string] $Project
  )

  $knowledgeRoot = Resolve-KnowledgeRoot
  $candidate = Join-Path $knowledgeRoot "knowledge\domain\project-$Project.md"
  if (Test-Path $candidate) {
    return $candidate
  }

  $domainRoot = Join-Path $knowledgeRoot "knowledge\domain"
  if (Test-Path $domainRoot) {
    $matched = Get-ChildItem -Path $domainRoot -Filter "project-*.md" -File |
      Where-Object { $_.BaseName -eq "project-$Project" } |
      Select-Object -First 1
    if ($matched) {
      return $matched.FullName
    }
  }

  throw "Project knowledge file not found: knowledge\domain\project-$Project.md"
}

function Get-ProjectRootFromKnowledge {
  param(
    [string] $KnowledgeFile
  )

  $line = Get-Content -Encoding UTF8 $KnowledgeFile |
    Where-Object { $_ -match '^project_root:\s*(.+)\s*$' } |
    Select-Object -First 1

  if (-not $line) {
    return ""
  }

  return ($line -replace '^project_root:\s*', '').Trim().Trim('"').Trim("'").Trim('`')
}

function Get-ProjectRootFromIndex {
  param(
    [string] $Project
  )

  $knowledgeRoot = Resolve-KnowledgeRoot
  $indexFile = Join-Path $knowledgeRoot "knowledge\service-map\workspace-projects.md"
  if (-not (Test-Path $indexFile)) {
    return ""
  }

  $escapedProject = [regex]::Escape($Project)
  $projectRowPattern = '^\|\s*' + $escapedProject + '\s*\|\s*`([^`]+)`'
  $row = Get-Content -Encoding UTF8 $indexFile |
    Where-Object { $_ -match $projectRowPattern } |
    Select-Object -First 1

  if ($row -match $projectRowPattern) {
    return $Matches[1]
  }

  return ""
}

function Resolve-Project {
  param(
    [string] $Project
  )

  if (-not $Project) {
    throw "Missing project name. Example: ak check poseidon"
  }

  $knowledgeFile = Get-ProjectKnowledgeFile $Project
  $projectRoot = Get-ProjectRootFromKnowledge $knowledgeFile
  if (-not $projectRoot) {
    $projectRoot = Get-ProjectRootFromIndex $Project
  }

  if (-not $projectRoot) {
    throw "Cannot resolve project root for: $Project. Add project_root to the knowledge file frontmatter."
  }

  if (-not (Test-Path $projectRoot)) {
    throw "Project root does not exist: $projectRoot"
  }

  $knowledgeRoot = Resolve-KnowledgeRoot
  # The base CLI expects knowledge-file relative to knowledge root; keep this compatible with Windows PowerShell 5.1.
  $resolvedKnowledgeRoot = (Resolve-Path $knowledgeRoot).Path.TrimEnd('\', '/')
  $resolvedKnowledgeFile = (Resolve-Path $knowledgeFile).Path
  if ($resolvedKnowledgeFile.StartsWith($resolvedKnowledgeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relativeKnowledgeFile = $resolvedKnowledgeFile.Substring($resolvedKnowledgeRoot.Length).TrimStart('\', '/')
  } else {
    $relativeKnowledgeFile = $knowledgeFile
  }

  return @{
    ProjectRoot = $projectRoot
    KnowledgeFile = $relativeKnowledgeFile
  }
}

function Show-Projects {
  $knowledgeRoot = Resolve-KnowledgeRoot
  $indexFile = Join-Path $knowledgeRoot "knowledge\service-map\workspace-projects.md"
  if (-not (Test-Path $indexFile)) {
    Write-Output "Project index not found: knowledge\service-map\workspace-projects.md"
    return
  }

  Write-Output "Registered projects:"
  Get-Content -Encoding UTF8 $indexFile |
    Where-Object { $_ -match '^\|\s*[^|-][^|]*\s*\|\s*`[^`]+`' } |
    ForEach-Object {
      if ($_ -match '^\|\s*([^|]+?)\s*\|\s*`([^`]+)`') {
        Write-Output ("- {0} -> {1}" -f $Matches[1].Trim(), $Matches[2].Trim())
      }
    }
}

if ($args.Count -eq 0 -or $args[0] -eq "-h" -or $args[0] -eq "--help") {
  Write-AkHelp
  exit 0
}

if ($args[0] -eq "help") {
  $topic = ""
  if ($args.Count -gt 1) {
    $topic = $args[1]
  }
  Write-AkHelp $topic
  exit 0
}

$command = $args[0]
$rest = @()
if ($args.Count -gt 1) {
  $rest = $args[1..($args.Count - 1)]
}

if ($rest -contains "--help" -or $rest -contains "-h") {
  Write-AkHelp $command
  exit 0
}

try {
  switch ($command) {
    { $_ -in @("task", "before", "before-task") } {
      $queryParts = $rest | Where-Object { $_ -ne "--json" }
      $cliArgs = @("before-task", ($queryParts -join " "))
      if ($rest -contains "--json") { $cliArgs += "--json" }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    { $_ -in @("search", "s") } {
      $queryParts = $rest | Where-Object { $_ -ne "--json" }
      $cliArgs = @("search", ($queryParts -join " "))
      if ($rest -contains "--json") { $cliArgs += "--json" }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "projects" {
      Show-Projects
      exit 0
    }
    { $_ -in @("check", "stale") } {
      if (-not $rest[0]) {
        Write-AkHelp "check"
        exit 1
      }
      $project = Resolve-Project $rest[0]
      $cliArgs = @(
        "check-stale",
        "--project-root", $project.ProjectRoot,
        "--knowledge-file", $project.KnowledgeFile
      )
      if ($rest -contains "--deep") {
        $cliArgs += "--deep"
      }
      if ($rest -contains "--json") {
        $cliArgs += "--json"
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "refresh" {
      $projectName = $rest[0]
      if (-not $projectName) {
        Write-AkHelp "refresh"
        exit 1
      }
      $summary = ""
      if ($rest.Count -gt 1) {
        $summary = $rest[1..($rest.Count - 1)] -join " "
      }
      if (-not $summary) {
        $summary = "Refresh $projectName project knowledge"
      }

      $project = Resolve-Project $projectName
      Invoke-AgentKnowledge -CliArgs @(
        "refresh-project",
        "--project-root", $project.ProjectRoot,
        "--knowledge-file", $project.KnowledgeFile,
        "--summary", $summary
      )
    }
    { $_ -in @("bug", "prd", "tech") } {
      $target = ""
      $titleParts = @()
      for ($index = 0; $index -lt $rest.Count; $index++) {
        if ($rest[$index] -eq "--target") {
          if ($index + 1 -lt $rest.Count) {
            $target = $rest[$index + 1]
            $index++
          } else {
            throw "record-fix --target requires a knowledge file path"
          }
          continue
        }
        if ($rest[$index] -like "--target=*") {
          $target = $rest[$index].Substring("--target=".Length)
          if (-not $target) {
            throw "record-fix --target requires a knowledge file path"
          }
          continue
        }
        $titleParts += $rest[$index]
      }
      $title = $titleParts -join " "
      if (-not $title) {
        Write-AkHelp $command
        exit 1
      }
      $cliArgs = @("record-fix", "--type", $command, "--title", $title)
      if ($target) {
        $cliArgs += @("--target", $target)
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "rule" {
      $confirmed = $rest -contains "--confirmed"
      $title = ($rest | Where-Object { $_ -ne "--confirmed" }) -join " "
      if (-not $title) {
        Write-AkHelp "rule"
        exit 1
      }
      $cliArgs = @("add-rule", $title)
      if ($confirmed) {
        $cliArgs += "--confirmed"
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "promote" {
      if (-not $rest[0]) {
        Write-AkHelp "promote"
        exit 1
      }
      Invoke-AgentKnowledge -CliArgs @("promote", "--file", $rest[0])
    }
    "resolve" {
      if ($rest.Count -lt 1 -or $rest.Count -gt 2) {
        throw "ak resolve accepts exactly one file and an optional --confirm-legacy"
      }
      $source = $rest[0]
      if ([string]::IsNullOrWhiteSpace($source) -or $source.StartsWith("--")) {
        throw "ak resolve requires a non-empty inbox fix file before --confirm-legacy"
      }
      $confirmLegacy = $false
      if ($rest.Count -eq 2) {
        if ($rest[1] -ne "--confirm-legacy") {
          throw "ak resolve accepts only one optional --confirm-legacy after the file"
        }
        $confirmLegacy = $true
      }
      $cliArgs = @("resolve-fix", "--file", $source)
      if ($confirmLegacy) {
        $cliArgs += "--confirm-legacy"
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "pending" {
      Invoke-AgentKnowledge -CliArgs @("list-pending")
    }
    "adapters" {
      if ($rest.Count -gt 1 -or ($rest.Count -eq 1 -and $rest[0] -ne "--check")) {
        throw "ak adapters accepts only an optional --check"
      }
      $cliArgs = @("sync-adapters", "--repository-root", $ToolRepoRoot)
      if ($rest -contains "--check") {
        $cliArgs += "--check"
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "doctor" {
      if ($rest.Count -gt 1 -or ($rest.Count -eq 1 -and $rest[0] -ne "--json")) {
        throw "ak doctor accepts no arguments or a single --json"
      }
      $cliArgs = @("doctor", "--repository-root", $ToolRepoRoot)
      if ($rest -contains "--json") {
        $cliArgs += "--json"
      }
      Invoke-AgentKnowledge -CliArgs $cliArgs
    }
    "raw" {
      Invoke-AgentKnowledge -CliArgs $rest
    }
    default {
      Write-Error "Unknown ak command: $command"
      Write-AkHelp
      exit 1
    }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
