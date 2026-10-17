/**
 * DSH 升级后的契约体检。
 *
 * 用途：每次把 DSH 升到新版本后，先跑这个脚本，确认 dsh-toolbox 依赖的宿主契约
 * 仍然存在、四道门仍然生效。它只读、不删任何东西。
 *
 * 用法：
 *   node tools/contract-check.mjs                 # 默认 http://127.0.0.1:3080
 *   node tools/contract-check.mjs --base http://127.0.0.1:3099
 *
 * 退出码：0 全部通过；1 有失败项（升级前必须修好）。
 */

import { request as httpRequest } from 'node:http'

const args = process.argv.slice(2)
const baseArg = args.indexOf('--base')
const BASE = baseArg >= 0 ? args[baseArg + 1] : 'http://127.0.0.1:3080'
const HOST = BASE.replace(/^https?:\/\//, '')

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (detail ? '  — ' + detail : ''))
}

/** 裸 http 请求：只有它能真的伪造 Host 头。 */
function rawGet(path, headers = {}) {
  // 用顶层 import 引入，见文件头
  const url = new URL(BASE + path)
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET', headers },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode })
      },
    )
    req.on('error', () => resolve({ status: 0 }))
    req.end()
  })
}

async function call(path, headers = {}, init = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: { host: HOST, ...headers },
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch (error) {
    json = undefined
  }
  return { status: response.status, text, json }
}

/** 1. 凭证端点：必须 200、no-store、拿到 64 位令牌。 */
async function checkToken() {
  try {
    const response = await fetch(BASE + '/api/archive-manager/token', { headers: { host: HOST } })
    const body = await response.json().catch(() => undefined)
    const noStore = response.headers.get('cache-control') === 'no-store'
    const tokenOk = typeof body?.token === 'string' && body.token.length >= 32
    record('凭证端点可用', response.status === 200 && noStore && tokenOk, 'HTTP ' + response.status)
    return tokenOk ? body.token : undefined
  } catch (error) {
    record('凭证端点可用', false, String(error && error.message))
    return undefined
  }
}

async function run(token) {
  // 2. 列表：带令牌 200，无令牌 401，伪造 Host 403。
  if (token) {
    const withToken = await call('/api/archive-manager/list', {
      origin: BASE,
      'x-dsh-toolbox': '1',
      'x-dsh-toolbox-token': token,
    })
    const rows = Array.isArray(withToken.json?.rows) ? withToken.json.rows.length : -1
    record('列表可读（带令牌）', withToken.status === 200 && rows >= 0, 'HTTP ' + withToken.status + '，' + rows + ' 条')
  } else {
    record('列表可读（带令牌）', false, '没有令牌，跳过')
  }

  const noToken = await call('/api/archive-manager/list', { origin: BASE })
  record('列表拒绝无令牌', noToken.status === 401, 'HTTP ' + noToken.status)

  // fetch 不允许伪造 Host，必须用裸请求——否则这一项就是假通过。
  const forged = await rawGet('/api/archive-manager/list', {
    host: 'evil.example',
    origin: BASE,
    'x-dsh-toolbox': '1',
    'x-dsh-toolbox-token': token || 'x'.repeat(64),
  })
  record('伪造 Host 被拒', forged.status === 403, 'HTTP ' + forged.status)

  const badJson = await call('/api/archive-manager/delete', {
    origin: BASE,
    'x-dsh-toolbox': '1',
    'x-dsh-toolbox-token': token || 'x'.repeat(64),
    'content-type': 'application/json',
  }, { method: 'POST', body: '{"sessionId":"nope"}' })
  record('参数校验生效（坏 id 被拒）', badJson.status === 400, 'HTTP ' + badJson.status)

  const failed = results.filter((item) => !item.ok)
  console.log('')
  console.log('  合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length)
  if (failed.length > 0) {
    console.log('')
    console.log('  升级后的契约体检未通过，先修好再继续用：')
    for (const item of failed) console.log('    - ' + item.name + (item.detail ? '：' + item.detail : ''))
    return 1
  }
  return 0
}

const token = await checkToken()
const code = await run(token)
process.exit(code)
