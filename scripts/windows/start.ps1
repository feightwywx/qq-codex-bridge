param([switch]$Pair)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$node = (Get-Command node.exe).Source
$bridge = Join-Path $PSScriptRoot 'bridge.mjs'
if ($Pair) {
    & $node $bridge --pair
    exit $LASTEXITCODE
}
if (-not $env:CODEX_BINARY_PATH) {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    $env:CODEX_BINARY_PATH = if ($package) {
        Join-Path $package.InstallLocation 'app/resources/codex.exe'
    } else {
        (Get-Command codex.exe).Source
    }
}
Push-Location -LiteralPath $repo
try {
    & $node '--env-file=.env' $bridge
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
