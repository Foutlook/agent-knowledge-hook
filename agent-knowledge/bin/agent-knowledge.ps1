$ScriptPath = Join-Path $PSScriptRoot "agent-knowledge.js"
node $ScriptPath @args
exit $LASTEXITCODE
