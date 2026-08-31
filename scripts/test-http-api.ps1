# Irodori Studio HTTP API smoke test
# Prefer Node on Windows (UTF-8 / JSON are reliable):
#   $env:IRODORI_API_TOKEN = "<token>"
#   node scripts/test-http-api.mjs
#
# PowerShell fallback:
#   .\scripts\test-http-api.ps1

param(
    [string]$BaseUrl = $(if ($env:IRODORI_BASE_URL) { $env:IRODORI_BASE_URL } else { "http://127.0.0.1:18790" }),
    [string]$Token = $env:IRODORI_API_TOKEN,
    [string]$SpeakerId = $env:IRODORI_SPEAKER_ID,
    [string]$OutDir = $(Join-Path $PSScriptRoot "api-test-out"),
    [string]$PhrasesFile = $(Join-Path $PSScriptRoot "test-http-api-phrases.json"),
    [switch]$SaveRequestBodies
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "== $msg" -ForegroundColor Cyan
}

function Assert-Status([string]$name, [int]$code, [int[]]$expected) {
    if ($expected -notcontains $code) {
        throw "$name failed: HTTP $code (expected $($expected -join '/'))"
    }
    Write-Host "  OK ($code)" -ForegroundColor Green
}

function ConvertTo-ApiJson([object]$obj) {
    # PS 5.1 Invoke-WebRequest mishandles non-ASCII in -Body strings.
    # Serialize to UTF-8 bytes explicitly in Invoke-StudioRequest instead.
    return ($obj | ConvertTo-Json -Depth 10 -Compress)
}

function Invoke-StudioRequest {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [string]$JsonBody = $null,
        [string]$OutFile = $null,
        [switch]$NoAuth
    )

    $uri = "$BaseUrl$Path"
    $req = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = $Method

    if (-not $NoAuth) {
        $req.Headers.Add("Authorization", "Bearer $Token")
    }

    if ($Method -in @("POST", "PUT", "PATCH") -and -not [string]::IsNullOrEmpty($JsonBody)) {
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        $req.ContentType = "application/json; charset=utf-8"
        $req.ContentLength = $bodyBytes.Length
        $stream = $req.GetRequestStream()
        try {
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
        } finally {
            $stream.Close()
        }
    }

    try {
        $resp = $req.GetResponse()
    } catch [System.Net.WebException] {
        $errResp = $_.Exception.Response
        if ($errResp) {
            $reader = New-Object System.IO.StreamReader($errResp.GetResponseStream(), [System.Text.Encoding]::UTF8)
            $errBody = $reader.ReadToEnd()
            $reader.Close()
            throw "HTTP $([int]$errResp.StatusCode) $Method $Path`n$errBody"
        }
        throw
    }

    try {
        $responseStream = $resp.GetResponseStream()
        if ($OutFile) {
            $fs = [System.IO.File]::Create($OutFile)
            try {
                $responseStream.CopyTo($fs)
            } finally {
                $fs.Close()
            }
            return [PSCustomObject]@{ StatusCode = [int]$resp.StatusCode; Content = $null }
        }

        $reader = New-Object System.IO.StreamReader($responseStream, [System.Text.Encoding]::UTF8)
        try {
            $content = $reader.ReadToEnd()
        } finally {
            $reader.Close()
        }
        return [PSCustomObject]@{ StatusCode = [int]$resp.StatusCode; Content = $content }
    } finally {
        $resp.Close()
    }
}

function Invoke-ApiJson {
    param([string]$Path, [string]$Method = "GET", [object]$Body = $null)
    if ($null -eq $Body) {
        return Invoke-StudioRequest -Path $Path -Method $Method
    }
    $json = ConvertTo-ApiJson $Body
    return Invoke-StudioRequest -Path $Path -Method $Method -JsonBody $json
}

function Invoke-ApiBinary {
    param(
        [string]$Path,
        [string]$Method = "GET",
        [object]$Body = $null,
        [string]$OutFile,
        [string]$DebugName = $null
    )
    if ($null -ne $Body) {
        $json = ConvertTo-ApiJson $Body
        if ($SaveRequestBodies -and $DebugName) {
            $debugPath = Join-Path $OutDir "$DebugName.json"
            [System.IO.File]::WriteAllText($debugPath, $json, [System.Text.UTF8Encoding]::new($false))
            Write-Host "  saved request body: $debugPath"
        }
        Invoke-StudioRequest -Path $Path -Method $Method -JsonBody $json -OutFile $OutFile | Out-Null
    } else {
        Invoke-StudioRequest -Path $Path -Method $Method -OutFile $OutFile | Out-Null
    }
}

if (-not $Token) {
    Write-Error "IRODORI_API_TOKEN / -Token is required. Copy from Studio Settings -> Local HTTP server."
}

if (-not (Test-Path $PhrasesFile)) {
    throw "Phrases file not found: $PhrasesFile"
}

$phrases = Get-Content -LiteralPath $PhrasesFile -Encoding UTF8 -Raw | ConvertFrom-Json
$TextSynthesize = $phrases.synthesize
$TextJobLine1   = $phrases.jobLine1
$TextJobLine2   = $phrases.jobLine2
$TextConcat1    = $phrases.concat1
$TextConcat2    = $phrases.concat2
$TextVvCompat   = $phrases.vvCompat

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Base URL: $BaseUrl"
Write-Host "Output:   $OutDir"
Write-Host "Phrases:  $PhrasesFile"

# --- /v1/health ---
Write-Step "GET /v1/health"
$r = Invoke-ApiJson "/v1/health"
Assert-Status "health" $r.StatusCode 200
$health = $r.Content | ConvertFrom-Json
if (-not $health.ok) { throw "health.ok is false" }
Write-Host "  version=$($health.version) worker.busy=$($health.worker.busy)"

# --- /v1/speakers ---
Write-Step "GET /v1/speakers"
$r = Invoke-ApiJson "/v1/speakers"
Assert-Status "speakers" $r.StatusCode 200
$speakers = ($r.Content | ConvertFrom-Json).speakers
if (-not $speakers -or $speakers.Count -eq 0) {
    throw "No speakers found in Outputs. Add an embedding first."
}
if (-not $SpeakerId) {
    $SpeakerId = $speakers[0].id
}
Write-Host "  speaker: $SpeakerId"
$styleId = $speakers[0].styleId

# --- /v1/synthesize ---
Write-Step "POST /v1/synthesize"
Write-Host "  text: $TextSynthesize"
$synthOut = Join-Path $OutDir "synthesize.wav"
$synthBody = @{
    text    = $TextSynthesize
    speaker = $SpeakerId
    format  = "wav"
    split   = $true
}
Invoke-ApiBinary -Path "/v1/synthesize" -Method POST -Body $synthBody -OutFile $synthOut -DebugName "synthesize-body"
$synthSize = (Get-Item $synthOut).Length
if (-not (Test-Path $synthOut) -or $synthSize -lt 100) {
    throw "synthesize output missing or too small"
}
Write-Host "  wrote $synthOut ($synthSize bytes)"

# --- /v1/jobs ---
Write-Step "POST /v1/jobs + poll + line download + concat"
Write-Host "  line1: $TextJobLine1"
Write-Host "  line2: $TextJobLine2"
$jobBody = @{
    lines = @(
        @{ text = $TextJobLine1; speaker = $SpeakerId }
        @{ text = $TextJobLine2; speaker = $SpeakerId }
    )
    split = $false
}
$r = Invoke-ApiJson -Path "/v1/jobs" -Method POST -Body $jobBody
Assert-Status "create-job" $r.StatusCode 200
$jobId = ($r.Content | ConvertFrom-Json).jobId
Write-Host "  jobId=$jobId"

$deadline = (Get-Date).AddMinutes(10)
do {
    Start-Sleep -Seconds 2
    $r = Invoke-ApiJson "/v1/jobs/$jobId"
    $job = $r.Content | ConvertFrom-Json
    Write-Host "  status=$($job.status) completed=$($job.completed)/$($job.total)"
    if ((Get-Date) -gt $deadline) { throw "job timeout" }
} while ($job.status -in @("queued", "running"))

if ($job.status -ne "completed") {
    throw "job ended with status $($job.status): $($job.error)"
}

$line0 = Join-Path $OutDir "job-line0.wav"
Invoke-ApiBinary -Path "/v1/jobs/$jobId/lines/0" -OutFile $line0
Write-Host "  wrote $line0"

$jobConcat = Join-Path $OutDir "job-concat.wav"
Invoke-ApiBinary -Path "/v1/jobs/$jobId/concat" -Method POST -Body @{ format = "wav" } -OutFile $jobConcat
Write-Host "  wrote $jobConcat"

# --- /v1/concat ---
Write-Step "POST /v1/concat"
Write-Host "  line1: $TextConcat1"
Write-Host "  line2: $TextConcat2"
$concatOut = Join-Path $OutDir "concat.wav"
$concatBody = @{
    lines = @(
        @{ text = $TextConcat1; speaker = $SpeakerId }
        @{ text = $TextConcat2; speaker = $SpeakerId }
    )
    format = "wav"
    split  = $true
}
Invoke-ApiBinary -Path "/v1/concat" -Method POST -Body $concatBody -OutFile $concatOut -DebugName "concat-body"
Write-Host "  wrote $concatOut"

# --- VOICEVOX compat (loopback, no auth) ---
Write-Step "VOICEVOX compat /speakers + /audio_query + /synthesis"
Write-Host "  text: $TextVvCompat"
$r = Invoke-StudioRequest -Path "/speakers" -NoAuth
Assert-Status "vv-speakers" $r.StatusCode 200
$vv = $r.Content | ConvertFrom-Json
if (-not $styleId -and $vv.Count -gt 0) {
    $styleId = $vv[0].styles[0].id
}
if (-not $styleId) { throw "No VOICEVOX style id" }
Write-Host "  styleId=$styleId"

$vvEncoded = [Uri]::EscapeDataString($TextVvCompat)
$r = Invoke-StudioRequest -Path "/audio_query?text=$vvEncoded&speaker=$styleId" -Method POST -NoAuth
Assert-Status "audio-query" $r.StatusCode 200
$queryJson = $r.Content

$vvOut = Join-Path $OutDir "vv-synthesis.wav"
Invoke-StudioRequest -Path "/synthesis?speaker=$styleId" -Method POST -JsonBody $queryJson -OutFile $vvOut -NoAuth | Out-Null
Write-Host "  wrote $vvOut"

Write-Host ""
Write-Host "All API smoke tests passed." -ForegroundColor Green
Write-Host "Play files under: $OutDir"
Write-Host "Tip: run with -SaveRequestBodies to dump UTF-8 JSON under api-test-out/"
