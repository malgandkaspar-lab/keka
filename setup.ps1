# One-step setup for Windows (PowerShell):  .\setup.ps1
# Creates .env (with generated secrets), asks for the free Pexels key and starts everything with Docker.
param([switch]$NoStart)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $NoStart -and -not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
  exit 1
}
if (-not $NoStart) { docker info *> $null }
if (-not $NoStart -and $LASTEXITCODE -ne 0) {
  Write-Host "Docker is not running. Start Docker Desktop, wait until it is ready, then run .\setup.ps1 again."
  exit 1
}

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$script:lines = @(Get-Content .env)

function Get-Var([string]$Key) {
  $line = $script:lines | Where-Object { $_.StartsWith("$Key=") } | Select-Object -First 1
  if ($line) { return $line.Substring($Key.Length + 1).Trim() } else { return "" }
}
function Set-Var([string]$Key, [string]$Value) {
  $found = $false
  $script:lines = @($script:lines | ForEach-Object {
    if ($_.StartsWith("$Key=")) { $found = $true; "$Key=$Value" } else { $_ }
  })
  if (-not $found) { $script:lines += "$Key=$Value" }
}
function New-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

if (-not (Get-Var "AUTH_SECRET")) { Set-Var "AUTH_SECRET" (New-Secret 48) }
if (-not (Get-Var "ENCRYPTION_KEY")) { Set-Var "ENCRYPTION_KEY" (New-Secret 32) }
if (-not (Get-Var "PEXELS_API_KEY")) {
  $key = Read-Host "Paste your free Pexels API key (https://www.pexels.com/api/), or press Enter to add it later"
  if ($key) { Set-Var "PEXELS_API_KEY" $key.Trim() }
}
[IO.File]::WriteAllLines((Join-Path $PSScriptRoot ".env"), [string[]]$script:lines)
Write-Host ".env is ready."

if ($NoStart) { exit 0 }

Write-Host "Starting Shorts Factory (the first start downloads about 6 GB, this can take a while)..."
docker compose up -d --build
Write-Host ""
Write-Host "Done. Open http://localhost:3000 in your browser and create your account."
Write-Host "The AI model keeps downloading in the background: docker compose logs -f ollama-pull"
