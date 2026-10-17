# Port dsh-quote-reply/client.js into dsh-toolbox as a container feature.
# Strategy: keep every component line verbatim; replace only the tiny plugin
# body (the old `apply`) with a container `mount(ctx, env)`.

$ErrorActionPreference = 'Stop'

$src = 'C:\Users\zhou0\DeepSeek_Harness_Projects\dsh-plugins\dsh-quote-reply\client.js'
$dstDir = 'C:\Users\zhou0\DeepSeek_Harness_Projects\dsh-plugins\dsh-toolbox\src\client\features'
$dst = Join-Path $dstDir 'quote-reply.js'

New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

$lines = Get-Content $src -Encoding UTF8

# --- locate the structural anchors -------------------------------------------
$reactIdx = -1
$hIdx = -1
$hookIdx = -1
$pluginReturnIdx = -1

for ($i = 0; $i -lt $lines.Count; $i++) {
    $t = $lines[$i].Trim()
    if ($reactIdx -lt 0 -and $t -eq "const React = require('react');") { $reactIdx = $i }
    if ($hIdx -lt 0 -and $t -eq 'const h = React.createElement;') { $hIdx = $i }
    if ($hookIdx -lt 0 -and $t -like 'const { useCallback, useEffect, useRef, useState } = React;*') { $hookIdx = $i }
    if ($pluginReturnIdx -lt 0 -and $lines[$i] -match '^\s{4}return \{$') { $pluginReturnIdx = $i }
}

Write-Output ("react line   : " + $reactIdx)
Write-Output ("h line       : " + $hIdx)
Write-Output ("hooks line   : " + $hookIdx)
Write-Output ("plugin return: " + $pluginReturnIdx)

if ($reactIdx -lt 0 -or $hIdx -lt 0 -or $hookIdx -lt 0 -or $pluginReturnIdx -lt 0) {
    throw 'anchor not found; refusing to guess'
}

# --- body: everything between `factory(require) {` and `return {`, minus the
#     three react lines. Keep the original indentation (legal JS, safer than a
#     blind dedent that could corrupt template literals).
$factoryIdx = -1
for ($i = 0; $i -lt $pluginReturnIdx; $i++) {
    if ($lines[$i] -match '^\s*factory\(require\) \{') { $factoryIdx = $i }
}
if ($factoryIdx -lt 0) { throw 'factory(require) { not found' }

$drop = @($reactIdx, $hIdx, $hookIdx)
$body = New-Object System.Collections.ArrayList
for ($i = $factoryIdx + 1; $i -lt $pluginReturnIdx; $i++) {
    if ($drop -contains $i) { continue }
    [void]$body.Add($lines[$i])
}

# --- the container body, written explicitly (the old apply was 5 statements) --
$mount = @(
    '',
    '/* ------------------------------------------------------------------ *',
    ' * container body                                                      *',
    ' * ------------------------------------------------------------------ */',
    '',
    '/**',
    ' * Mount the feature. Every effect is registered through env.track so a',
    ' * switch can remove the menu and the composer sink again.',
    ' * @param ctx - the client plugin context',
    ' * @param env - the container environment (track / h / log)',
    ' */',
    'export function mount(ctx, env) {',
    "    const t = ctx.locale.bind(NS);",
    '',
    "    env.track(ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'quote-reply: zh dictionary'));",
    "    env.track(ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'quote-reply: en dictionary'));",
    '',
    '    env.track(',
    '        ctx.effect(',
    '            () =>',
    '                ctx.slots.inject(OVERLAY_SLOT, () =>',
    '                    ctx.slots.register({ name: OVERLAY_SLOT, id: MENU_ID, order: 60 }, function QuoteMenuEntry() {',
    '                        return h(QuoteMenu, { t });',
    '                    }),',
    '                ),',
    "            'quote-reply: selection menu',",
    '        ),',
    '    );',
    '',
    '    env.track(',
    '        ctx.effect(',
    '            () => ctx.slots.inject(SINK_SLOT, () => ctx.slots.register({ name: SINK_SLOT, id: SINK_ID, order: 300 }, QuoteSink)),',
    "            'quote-reply: composer sink',",
    '        ),',
    '    );',
    '}',
    ''
)

$header = @(
    '/**',
    ' * Feature: quote-reply (migrated from dsh-plugins/dsh-quote-reply).',
    ' *',
    ' * Select conversation text and a floating card offers Quote / Copy; Quote',
    ' * writes the passage into the composer draft as a Markdown block. Everything',
    ' * below the header is the original component code, moved verbatim; only the',
    ' * plugin body became `mount(ctx, env)`, and every effect is tracked so the',
    ' * container can switch the feature off.',
    ' *',
    ' * React arrives through the runtime bridge (late-bound), never as an import.',
    ' */',
    '',
    "import { h, useCallback, useEffect, useRef, useState } from '../runtime.js';",
    ''
)

$out = New-Object System.Collections.ArrayList
foreach ($l in $header) { [void]$out.Add($l) }
foreach ($l in $body) { [void]$out.Add($l) }
foreach ($l in $mount) { [void]$out.Add($l) }

Set-Content -Path $dst -Value ($out -join "`r`n") -Encoding UTF8

Write-Output ''
Write-Output ("written: " + $dst + "  (" + (Get-Item $dst).Length + " bytes)")
Write-Output '--- 语法检查 ---'
& node --check $dst 2>&1 | Out-String
Write-Output '(无输出 = 通过)'
Write-Output '--- 头部 12 行 ---'
(Get-Content $dst -Encoding UTF8)[0..11] | ForEach-Object { '  ' + $_ }
Write-Output '--- 尾部 22 行 ---'
$all = Get-Content $dst -Encoding UTF8
$all[($all.Count-22)..($all.Count-1)] | ForEach-Object { '  ' + $_ }
