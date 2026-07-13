param(
  [int]$SampleSize = 5,
  [switch]$WriteArtifacts
)

$ErrorActionPreference = "Stop"
$apiBase = "https://api.inaturalist.org/v2/observations"
$lepidopteraTaxonId = 47157
$photoLicenses = "cc0,cc-by,cc-by-sa,cc-by-nc,cc-by-nc-sa,cc-by-nd,cc-by-nc-nd"
$userAgent = "inat-moth-lights-phase0/tomaugust"
$fields = "(id:!t,uuid:!t,created_at:!t,observed_on:!t,time_observed_at:!t,uri:!t,quality_grade:!t,place_guess:!t,taxon:(id:!t,rank:!t,name:!t,preferred_common_name:!t),photos:(id:!t,url:!t,attribution:!t,license_code:!t))"

function New-QueryUrl {
  param([hashtable]$Parameters)

  $pairs = foreach ($entry in $Parameters.GetEnumerator() | Sort-Object Key) {
    "{0}={1}" -f [uri]::EscapeDataString([string]$entry.Key), [uri]::EscapeDataString([string]$entry.Value)
  }
  "${apiBase}?$($pairs -join '&')"
}

function Invoke-InatRequest {
  param([hashtable]$Parameters)

  $headers = @{
    Accept = "application/json"
    "User-Agent" = $userAgent
  }
  Invoke-RestMethod -UseBasicParsing -Uri (New-QueryUrl $Parameters) -Headers $headers -TimeoutSec 30
}

function Get-MediumPhotoUrl {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
  $Url -replace "/(square|thumb|small|medium|large|original)\.([A-Za-z0-9]+)$", '/medium.$2'
}

function ConvertTo-NormalizedObservation {
  param($Observation)

  $photo = @($Observation.photos)[0]
  [ordered]@{
    id = "inat-$($Observation.id)"
    taxonId = if ($Observation.taxon) { $Observation.taxon.id } else { $null }
    scientificName = if ($Observation.taxon) { $Observation.taxon.name } else { $null }
    commonName = if ($Observation.taxon) { $Observation.taxon.preferred_common_name } else { $null }
    taxonRank = if ($Observation.taxon) { $Observation.taxon.rank } else { $null }
    createdAt = $Observation.created_at
    observedAt = if ($Observation.time_observed_at) { $Observation.time_observed_at } else { $Observation.observed_on }
    place = $Observation.place_guess
    qualityGrade = $Observation.quality_grade
    imageUrl = if ($photo) { Get-MediumPhotoUrl $photo.url } else { $null }
    imageAttribution = if ($photo) { $photo.attribution } else { $null }
    imageLicense = if ($photo) { $photo.license_code } else { $null }
    observationUrl = $Observation.uri
  }
}

function ConvertTo-RedactedFixture {
  param($Contract)

  $copy = $Contract | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  for ($index = 0; $index -lt @($copy.observations).Count; $index++) {
    $number = $index + 1
    $observation = $copy.observations[$index]
    $observation.id = "inat-example-$number"
    $observation.place = @("Northern Europe", "Central America", "North America", "Southeast Asia", "Southern Africa")[$index % 5]
    $observation.imageAttribution = "Example attribution (licensed media)"
    $observation.observationUrl = "https://www.inaturalist.org/observations/example-$number"
    if ($observation.imageUrl) {
      $observation.imageUrl = "https://example.invalid/images/moth-$number-medium.jpg"
    }
  }
  $copy.cursor = "example-cursor"
  $copy
}

if ($SampleSize -lt 1 -or $SampleSize -gt 20) {
  throw "SampleSize must be between 1 and 20."
}

$commonParameters = @{
  taxon_id = $lepidopteraTaxonId
  photos = "true"
  photo_license = $photoLicenses
}

$sampleParameters = $commonParameters.Clone()
$sampleParameters.order_by = "created_at"
$sampleParameters.order = "desc"
$sampleParameters.per_page = $SampleSize
$sampleParameters.fields = $fields

$sampleResponse = Invoke-InatRequest $sampleParameters
$normalized = @($sampleResponse.results | ForEach-Object { ConvertTo-NormalizedObservation $_ })
$cursor = if ($sampleResponse.results) {
  [string](($sampleResponse.results | Measure-Object -Property id -Maximum).Maximum)
} else {
  $null
}

$contract = [ordered]@{
  fetchedAt = [datetime]::UtcNow.ToString("o")
  stale = $false
  cursor = $cursor
  observations = $normalized
}

# Measure four six-hour UTC windows from the most recent complete UTC day.
$measurementDay = [datetime]::UtcNow.Date.AddDays(-1)
$volume = for ($hour = 0; $hour -lt 24; $hour += 6) {
  $start = $measurementDay.AddHours($hour)
  $end = $start.AddHours(6).AddMilliseconds(-1)
  $parameters = $commonParameters.Clone()
  $parameters.created_d1 = $start.ToString("yyyy-MM-ddTHH:mm:ssZ")
  $parameters.created_d2 = $end.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $parameters.per_page = 1
  $parameters.fields = "id"
  $response = Invoke-InatRequest $parameters
  [ordered]@{
    startUtc = $start.ToString("o")
    endUtc = $end.ToString("o")
    observations = [int]$response.total_results
    observationsPerHour = [math]::Round(([double]$response.total_results / 6), 1)
  }
  Start-Sleep -Milliseconds 1100
}

$corsUrl = New-QueryUrl @{
  taxon_id = $lepidopteraTaxonId
  per_page = 1
  fields = "id"
}
$corsResponse = Invoke-WebRequest -UseBasicParsing -Uri $corsUrl -Headers @{
  Origin = "http://localhost:8000"
  "User-Agent" = $userAgent
} -TimeoutSec 30

$report = [ordered]@{
  generatedAt = [datetime]::UtcNow.ToString("o")
  apiVersion = "2.2.0"
  endpoint = $apiBase
  taxonId = $lepidopteraTaxonId
  sampleQuery = New-QueryUrl $sampleParameters
  sampleCount = $normalized.Count
  cors = [ordered]@{
    testOrigin = "http://localhost:8000"
    accessControlAllowOrigin = [string]$corsResponse.Headers["Access-Control-Allow-Origin"]
    accessControlAllowMethods = [string]$corsResponse.Headers["Access-Control-Allow-Methods"]
  }
  volumeWindows = $volume
}

Write-Output "Normalized project contract:"
$contract | ConvertTo-Json -Depth 10
Write-Output ""
Write-Output "Phase 0 measurements:"
$report | ConvertTo-Json -Depth 10

if ($WriteArtifacts) {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $fixtureDirectory = Join-Path $projectRoot "fixtures"
  $researchDirectory = Join-Path $projectRoot "research"
  New-Item -ItemType Directory -Force -Path $fixtureDirectory, $researchDirectory | Out-Null

  $redacted = ConvertTo-RedactedFixture $contract
  $redacted | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $fixtureDirectory "observations-page-1.json") -Encoding UTF8
  ([ordered]@{ fetchedAt = $contract.fetchedAt; stale = $false; cursor = $redacted.cursor; observations = @() }) |
    ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $fixtureDirectory "observations-empty.json") -Encoding UTF8
  ([ordered]@{ fetchedAt = $contract.fetchedAt; stale = $true; cursor = $redacted.cursor; observations = @(); error = "fixture-upstream-unavailable" }) |
    ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $fixtureDirectory "observations-error.json") -Encoding UTF8
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $researchDirectory "phase-0-measurements.json") -Encoding UTF8

  Write-Output ""
  Write-Output "Wrote redacted fixtures to $fixtureDirectory"
  Write-Output "Wrote measurements to $researchDirectory"
}
