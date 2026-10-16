[CmdletBinding()]
param(
    [string]$HostName = $(if ($env:TOMIFY_AGENT_HOST) { $env:TOMIFY_AGENT_HOST } else { 'tom@tomify' }),
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$repo = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repo) { throw 'Run this script inside the Tomify checkout.' }
Push-Location $repo
try {
    if ($Rollback) {
        & ssh -t $HostName 'sudo /opt/tomify/current/scripts/install-agent-release.sh --rollback'
        if ($LASTEXITCODE -ne 0) { throw 'Remote rollback failed.' }
        return
    }

    $dirty = (& git status --porcelain -- recovery-agent shared)
    if ($dirty) { throw "Commit or discard changes under recovery-agent/ and shared/ before deploying:`n$($dirty -join "`n")" }

    $sha = (& git rev-parse --short HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git revision.' }
    $archive = Join-Path ([IO.Path]::GetTempPath()) "tomify-agent-$sha.tar.gz"
    $remoteArchive = "/tmp/tomify-agent-$sha.tar.gz"
    try {
        & tar -czf $archive recovery-agent shared package.json scripts/install-agent-release.sh
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the agent release archive.' }
        & scp $archive "${HostName}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Could not copy the agent release archive.' }

        $remote = "sudo bash -o pipefail -c 'tar -xOf $remoteArchive scripts/install-agent-release.sh | bash -s -- --archive $remoteArchive --sha $sha; status=`$?; rm -f $remoteArchive; exit `$status'"
        & ssh -t $HostName $remote
        if ($LASTEXITCODE -ne 0) { throw 'Remote agent installation failed.' }
    }
    finally {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
