# Port dsh-panel-menu/client.js into dsh-toolbox as a container feature.
#
# Strategy (same as quote-reply): keep every module-level definition and the whole
# old `apply` body VERBATIM; only the wrapper changes:
#   - the loader envelope and the `require('react')` trio are dropped;
#   - `apply(ctx) { ... }` becomes `function applyBody(ctx) { ... }`;
#   - `mount(ctx, env)` runs applyBody against a Proxy whose `effect` is tracked,
#     so the switch can dispose every slot and the injected stylesheet with it.

$ErrorActionPreference = 'Stop'

$src = 'C:\Users\zhou0\DeepSeek_Harness_Projects\dsh-plugins\dsh-panel-menu\client.js'
$dstDir = 'C:\Users\zhou0\DeepSeek_Harness_Projects\dsh-plugins\dsh-toolbox\src\client\features'
$dst = Join-Path $dstDir 'panel-menu.js'

$lines = Get-Content $src -Encoding UTF8

function Find-Line([string]$pattern, [int]$from, [int]$to) {
    for ($i = $from; $i -lt $to; $i++) {
        if ($lines[$i] -match $pattern) { return $i }
    }
    return -1
}

$factoryIdx = Find-Line '^\s*factory\(require\) \{' 0 $lines.Count
$pluginReturnIdx = Find-Line '^\s{4}return \{$' ($factoryIdx + 1) $lines.Count
$applyIdx = Find-Line '^\s{6}apply\(ctx\) \{' $pluginReturnIdx $lines.Count
$applyEndIdx = Find-Line '^\s{6}\},$' ($applyIdx + 1) $lines.Count

Write-Output ("factory      : " + $factoryIdx)
Write-Output ("plugin return: " + $pluginReturnIdx)
Write-Output ("apply start  : " + $applyIdx)
Write-Output ("apply end    : " + $applyEndIdx)

if ($factoryIdx -lt 0 -or $pluginReturnIdx -lt 0 -or $applyIdx -lt 0 -or $applyEndIdx -lt 0) {
    throw 'anchors not found; refusing to guess'
}

# --- hooks used by the old file -------------------------------------------
$hookNames = @()
for ($i = $factoryIdx; $i -lt $applyEndIdx; $i++) {
    if ($lines[$i] -match '^\s*const \{([^}]*)\} = React;\s*$') {
        $hookNames = ($matches[1] -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
        break
    }
}
Write-Output ("hooks        : " + ($hookNames -join ', '))

$reactDot = 0
for ($i = $factoryIdx; $i -lt $applyEndIdx; $i++) {
    if ($lines[$i] -match 'React\.') { $reactDot++ }
}
Write-Output ("React.* uses : " + $reactDot + "   (0 = safe to move to the runtime bridge)")

# --- module-level head: factory+1 .. pluginReturn-1, minus the react trio ---
$drop = @()
for ($i = $factoryIdx; $i -lt $pluginReturnIdx; $i++) {
    if ($lines[$i] -match '^\s*const React = require|^\s*const h = React\.createElement|^\s*const \{[^}]*\} = React;') {
        $drop += $i
    }
}

$headLines = New-Object System.Collections.ArrayList
for ($i = $factoryIdx + 1; $i -lt $pluginReturnIdx; $i++) {
    if ($drop -contains $i) { continue }
    [void]$headLines.Add($lines[$i])
}

# --- the old apply body, verbatim ------------------------------------------
$bodyLines = New-Object System.Collections.ArrayList
for ($i = $applyIdx + 1; $i -lt $applyEndIdx; $i++) { [void]$bodyLines.Add($lines[$i]) }

# --- assemble ---------------------------------------------------------------
$header = @(
    '/**',
    ' * Feature: panel-menu (S4-a, migrated from dsh-plugins/dsh-panel-menu).',
    ' *',
    ' * What it does: the sidebar grows five panel rows over time; this feature hides',
    ' * them behind one "all panels" trigger in the sidebar footer, and lists them in a',
    ' * popover in the frame overlay. The intent is to give the conversation list the',
    ' * vertical space back.',
    ' *',
    ' * Everything below the header is the original code, moved verbatim: the module',
    ' * level helpers, the menu store, and the whole old `apply` body (now `applyBody`).',
    ' * Only two things changed:',
    ' *',
    ' *   1. `ctx.effect` is redirected through `env.track` (see `mount`), so switching',
    ' *      the feature off disposes both slots. The stylesheet that hides the native',
    ' *      rows is rendered BY the trigger component as a React <style> node, so it',
    ' *      disappears with the component: dispose brings the hidden rows straight',
    ' *      back. That is the hard acceptance criterion for this feature.',
    ' *   2. `layout` is resolved through the inject-free `ctx.get("layout")` path when',
    ' *      it is not declared, because the toolbox client only injects slots+locale.',
    ' *',
    ' * React arrives through the runtime bridge (late-bound), never as an import.',
    ' */',
    '',
    ("import { h" + $(if ($hookNames.Count -gt 0) { ', ' + ($hookNames -join ', ') } else { '' }) + " } from '../runtime.js';"),
    ''
)

$mountCode = @(
    '',
    '/** Clear the shared menu state so a re-mount never reopens the old popover. */',
    'export function resetMenuState() {',
    '    try {',
    "        setMenu({ open: false, anchor: null, items: [], error: null })",
    '    } catch (error) {',
    '        /* the store is rebuilt lazily; nothing to clear */',
    '    }',
    '}',
    '',
    '/**',
    ' * Mount the feature.',
    ' *',
    ' * `applyBody` is the original `apply`, unchanged, so it still calls `ctx.effect`.',
    ' * The proxy turns every one of those into a tracked disposer: without it the',
    ' * effects would attach to the client plugin fiber and survive a switch-off,',
    ' * leaving the sidebar rows hidden forever.',
    ' *',
    ' * @param ctx - the client plugin context',
    ' * @param env - the container environment',
    ' * @returns a disposer that also clears the shared menu state',
    ' */',
    'export function mount(ctx, env) {',
    '    resetMenuState()',
    '',
    '    const scoped = new Proxy(ctx, {',
    '        get(target, prop) {',
    "            if (prop === 'effect') {",
    '                return (fn, label) => env.track(target.effect(fn, label))',
    '            }',
    "            if (prop === 'layout') {",
    '                // Declared inject is the fast path; ctx.get() is the safe one.',
    '                try {',
    '                    const declared = Reflect.get(target, prop)',
    '                    if (declared) return declared',
    '                } catch (error) {',
    '                    /* not declared by this plugin: fall through */',
    '                }',
    "                return typeof target.get === 'function' ? target.get('layout') : undefined",
    '            }',
    '            return Reflect.get(target, prop)',
    '        },',
    '    })',
    '',
    '    applyBody(scoped)',
    '',
    '    const dispose = () => resetMenuState()',
    '    env.track(dispose)',
    '    return dispose',
    '}',
    ''
)

$out = New-Object System.Collections.ArrayList
foreach ($l in $header) { [void]$out.Add($l) }
foreach ($l in $headLines) { [void]$out.Add($l) }
[void]$out.Add('/**')
[void]$out.Add(' * The original plugin body, verbatim.')
[void]$out.Add(' * @param ctx - the (possibly proxied) client context')
[void]$out.Add(' */')
[void]$out.Add('function applyBody(ctx) {')
foreach ($l in $bodyLines) { [void]$out.Add($l) }
[void]$out.Add('}')
foreach ($l in $mountCode) { [void]$out.Add($l) }

Set-Content -Path $dst -Value ($out -join "`r`n") -Encoding UTF8

Write-Output ''
Write-Output ("written: " + $dst + "  (" + (Get-Item $dst).Length + " bytes)")
Write-Output '--- 语法检查 ---'
& node --check $dst 2>&1 | Out-String
Write-Output '(无输出 = 通过)'
Write-Output '--- 头部 6 行 ---'
(Get-Content $dst -Encoding UTF8)[0..5] | ForEach-Object { '  ' + $_ }
Write-Output '--- 尾部 14 行 ---'
$all = Get-Content $dst -Encoding UTF8
$all[($all.Count-14)..($all.Count-1)] | ForEach-Object { '  ' + $_ }
