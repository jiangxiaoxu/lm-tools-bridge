$ErrorActionPreference = 'Stop'

param(
  [string]$Endpoint = 'http://127.0.0.1:48123/mcp',
  [string]$Query = 'box'
)

$headers = @{ Accept = 'application/json, text/event-stream' }

function Get-LastSseDataLine {
  param([string]$Content)
  $lines = $Content -split "`n"
  $dataLines = $lines | Where-Object { $_ -like 'data:*' }
  if (-not $dataLines -or $dataLines.Count -eq 0) {
    return $null
  }
  return $dataLines[-1].Substring(5).Trim()
}

function Invoke-McpJson {
  param([hashtable]$Payload)
  $body = $Payload | ConvertTo-Json -Depth 50
  $res = Invoke-WebRequest -UseBasicParsing -Uri $Endpoint -Method Post -Headers $headers -Body $body -ContentType 'application/json'
  $jsonLine = Get-LastSseDataLine -Content $res.Content
  if (-not $jsonLine) {
    throw 'No SSE data line found in response.'
  }
  return $jsonLine | ConvertFrom-Json
}

function Get-WorkspacePath {
  $ws = Invoke-McpJson @{
    jsonrpc = '2.0'
    id = 1
    method = 'tools/call'
    params = @{ name = 'getVSCodeWorkspace'; arguments = @{} }
  }
  if (-not $ws.result.content -or $ws.result.content.Count -eq 0) {
    throw 'getVSCodeWorkspace returned no content.'
  }
  $info = $ws.result.content[0].text | ConvertFrom-Json
  if ($info.ownerWorkspacePath) {
    $first = ($info.ownerWorkspacePath -split ';')[0].Trim()
    if ($first) {
      return $first
    }
  }
  if ($info.workspaceFolders -and $info.workspaceFolders.Count -gt 0) {
    return $info.workspaceFolders[0].path
  }
  throw 'No workspace path detected.'
}

function Get-SampleFile {
  param([string]$Root)
  $rg = Get-Command rg -ErrorAction SilentlyContinue
  if ($rg) {
    $file = rg --files -g '*.mdg' $Root | Select-Object -First 1
    if (-not $file) {
      $file = rg --files $Root | Select-Object -First 1
    }
    return $file
  }
  $fallback = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
  return $fallback.FullName
}

function Build-ToolInput {
  param(
    [string]$ToolName,
    [pscustomobject]$ToolInfo,
    [string]$SampleFile,
    [string]$SampleDir,
    [string]$WorkspacePath,
    [string]$QueryText
  )

  $schema = $ToolInfo.inputSchema
  if (-not $schema -or -not $schema.required -or $schema.required.Count -eq 0) {
    return @{}
  }
  $props = $schema.properties
  $input = @{}

  foreach ($req in $schema.required) {
    $prop = $null
    if ($props) {
      $prop = $props.$req
    }
    $value = $null

    if ($req -match 'filePaths') {
      $value = if ($SampleFile) { @($SampleFile) } else { @() }
    } elseif ($req -match 'filePath|path|uri') {
      $value = if ($SampleFile) { $SampleFile } else { $WorkspacePath }
    } elseif ($req -match 'start.*line') {
      $value = 1
    } elseif ($req -match 'end.*line') {
      $value = 5
    } elseif ($req -match 'query|search|text|symbol|name') {
      $value = $QueryText
    } elseif ($req -match 'max') {
      $value = 10
    } elseif ($prop -and $prop.enum -and $prop.enum.Count -gt 0) {
      $value = $prop.enum[0]
    } elseif ($prop -and $prop.type) {
      switch ($prop.type) {
        'string' { $value = $QueryText }
        'number' { $value = 1 }
        'integer' { $value = 1 }
        'boolean' { $value = $false }
        'array' { $value = @() }
        'object' { $value = @{} }
        default { $value = $QueryText }
      }
    } else {
      $value = $QueryText
    }

    $input[$req] = $value
  }

  return $input
}

$workspacePath = Get-WorkspacePath
Write-Host "Workspace: $workspacePath"

$sampleFile = Get-SampleFile -Root $workspacePath
if (-not $sampleFile) {
  throw 'No sample file found in workspace.'
}
$sampleDir = Split-Path -Parent $sampleFile
Write-Host "Sample file: $sampleFile"

$toolsRes = Invoke-McpJson @{
  jsonrpc = '2.0'
  id = 2
  method = 'tools/call'
  params = @{ name = 'vscodeLmToolkit'; arguments = @{ action = 'listTools'; detail = 'names' } }
}
$available = @()
if ($toolsRes.result.content -and $toolsRes.result.content.Count -gt 0) {
  $available = ($toolsRes.result.content[0].text | ConvertFrom-Json).tools
}

$candidateTools = @(
  'copilot_searchCodebase',
  'copilot_searchWorkspaceSymbols',
  'copilot_findFiles',
  'copilot_findTextInFiles',
  'copilot_readFile',
  'copilot_getErrors',
  'copilot_readProjectStructure',
  'copilot_findTestFiles'
)

$toolsToCheck = $candidateTools | Where-Object { $available -contains $_ }
if (-not $toolsToCheck -or $toolsToCheck.Count -eq 0) {
  throw 'No target tools are enabled in MCP.'
}

$results = @()
$id = 10
foreach ($toolName in $toolsToCheck) {
  $toolInfoRes = Invoke-McpJson @{
    jsonrpc = '2.0'
    id = $id
    method = 'tools/call'
    params = @{ name = 'vscodeLmToolkit'; arguments = @{ action = 'getToolInfo'; name = $toolName } }
  }
  $id += 1
  $toolInfo = $toolInfoRes.result.content[0].text | ConvertFrom-Json
  $input = Build-ToolInput -ToolName $toolName -ToolInfo $toolInfo -SampleFile $sampleFile -SampleDir $sampleDir -WorkspacePath $workspacePath -QueryText $Query

  $invokeRes = Invoke-McpJson @{
    jsonrpc = '2.0'
    id = $id
    method = 'tools/call'
    params = @{ name = 'vscodeLmToolkit'; arguments = @{ action = 'invokeTool'; name = $toolName; input = $input } }
  }
  $id += 1

  $entry = [ordered]@{
    name = $toolName
    ok = $false
    promptTsx = $false
    hasTextParts = $false
    hasText = $false
    error = $null
  }

  if ($invokeRes.result -and $invokeRes.result.content -and $invokeRes.result.content.Count -gt 0) {
    $inner = $invokeRes.result.content[0].text | ConvertFrom-Json
    if ($inner.result) {
      foreach ($part in $inner.result) {
        if ($part.type -eq 'prompt-tsx') {
          $entry.promptTsx = $true
          if ($part.PSObject.Properties.Name -contains 'textParts') {
            $entry.hasTextParts = $true
          }
          if ($part.PSObject.Properties.Name -contains 'text') {
            $entry.hasText = $true
          }
        }
      }
      $entry.ok = $entry.promptTsx -and $entry.hasTextParts -and -not $entry.hasText
    } elseif ($invokeRes.result.isError) {
      $entry.error = 'tool_error'
    }
  } elseif ($invokeRes.error) {
    $entry.error = $invokeRes.error.message
  }

  $results += [pscustomobject]$entry
}

$results | Format-Table -AutoSize

$failed = $results | Where-Object { -not $_.ok }
if ($failed.Count -gt 0) {
  Write-Error 'Some tools did not return prompt-tsx textParts as expected.'
  exit 1
}

Write-Host 'All prompt-tsx tools returned textParts without text.'
exit 0
