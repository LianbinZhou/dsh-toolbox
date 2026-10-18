/**
 * 找「跨文件符号用了却没导入」——就是 session-adapter 漏导入 canonicalSessionId
 * 那一类错误。`node --check` 只查语法，测试只在覆盖到的路径上才炸，所以这类
 * 错误能让一整套测试全绿而真机必崩。
 *
 * 判定：某个名字在本文件里既没导入也没声明，却以调用形态出现；而这个名字
 * **在别的文件里被 export 过**。加这最后一条是为了压掉注释、CSS、方法定义
 * 带来的海量误报（第一版没有它，输出 200 多条全是噪声）。
 *
 * 用法：node tools/scan-undefined.mjs [--dir src]
 * 退出码：发现可疑项时为 1（可以挂进 CI），否则 0。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
const START = join(ROOT, dirIndex >= 0 ? args[dirIndex + 1] : 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path)
  }
  return out
}

/** 去掉注释与字符串，免得把注释里的英文、CSS 的 var() 当成调用。 */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** 从 `{` 开始配平，返回花括号里的原文（解构里可能有 `env = {}` 这种嵌套）。 */
function balancedFrom(source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, i)
    }
  }
  return ''
}

/** 本文件里可见的名字：导入、声明、参数、解构键。 */
function visibleNames(source) {
  const names = new Set()
  const add = (raw) => {
    for (const piece of raw.split(',')) {
      const name = piece.trim().split(/[:=\s]/)[0].replace(/^\.\.\./, '')
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) add(m[1].replace(/\bas\b/g, ', '))
  for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1])
  for (const m of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/\b(?:const|let|var)\s*\{/g)) {
    const open = source.indexOf('{', m.index)
    const inner = balancedFrom(source, open)
    if (inner !== '') add(inner)
  }
  for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) add(m[1])
  for (const m of source.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) add(m[1])
  return names
}

/** 本文件导出的名字（`export { a, b }` / `export function x` / `export const x`）。 */
function exportedNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

const files = walk(START)
const exportedSomewhere = new Set()
for (const file of files) for (const name of exportedNames(stripNoise(readFileSync(file, 'utf8')))) exportedSomewhere.add(name)

const findings = []
for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const stripped = stripNoise(raw)
  const visible = visibleNames(stripped)
  // 只在"去噪文本里真的存在"的调用才认，否则会把注释里的英文当成代码。
  const realCalls = new Set([...stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))
  // 行号必须拿原始文本算，否则剥掉注释后偏移全错。
  for (const m of raw.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1]
    if (visible.has(name)) continue
    if (!realCalls.has(name)) continue
    // 只关心「别的文件里 export 过」的名字：这正是漏导入的特征。
    if (!exportedSomewhere.has(name)) continue
    const line = raw.slice(0, m.index).split('\n').length
    findings.push({ file: relative(ROOT, file), line, name })
  }
}

console.log('扫描根目录：' + relative(ROOT, START) + '（' + files.length + ' 个文件）')
console.log('跨文件可见的导出名：' + exportedSomewhere.size + ' 个')
if (findings.length === 0) {
  console.log('✔ 没有「用了别的文件的导出名、却没导入」的情况')
  process.exitCode = 0
} else {
  console.log('✖ 可疑（别的文件导出过，这里没导入就用）：')
  for (const f of findings) console.log('  ' + f.file + ':' + f.line + '  ' + f.name)
  process.exitCode = 1
}
