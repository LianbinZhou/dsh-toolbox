/**
 * 回收箱接口的白名单：能看的字段有限，内部布局一律不出去。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createApiHandlers, TRASH_PATH } from '../src/host/features/archive/api-routes.js'

const ALLOW = { authorize: () => ({ ok: true }) }

async function getTrash(api) {
  const handlers = createApiHandlers({ guard: ALLOW, peerOf: () => '127.0.0.1', api })
  const server = createServer(handlers.trash)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const text = await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: TRASH_PATH, method: 'GET' },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve(body))
      },
    )
    req.on('error', reject)
    req.end()
  })
  await new Promise((resolve) => server.close(resolve))
  return { json: JSON.parse(text), text }
}

test('trash · 返回保留天数与 protectedCount，且不含路径/nonce', async () => {
  const { json, text } = await getTrash({
    list: async () => ({ ok: true, rows: [] }),
    trash: async () => ({
      ok: true,
      keptDays: 7,
      protectedCount: 2,
      rows: [
        { id: 'session-aaaaaaaa-1111-2222-3333-444444444444', phase: 'cleaned', keptDays: 7, at: 1, trashPath: 'C:/secret/trash/x', nonce: 'deadbeef', originalPath: 'C:/secret/orig' },
      ],
    }),
  })
  assert.equal(json.ok, true)
  assert.equal(json.keptDays, 7)
  assert.equal(json.protectedCount, 2)
  assert.equal(json.rows.length, 1)
  for (const banned of ['trashPath', 'originalPath', 'nonce', 'secret', 'deadbeef']) {
    assert.equal(text.includes(banned), false, '绝不能出现 ' + banned)
  }
})


test('4.5 · journal 损坏时 GET /trash 必须 fail closed', async () => {
  const { json } = await getTrash({
    list: async () => ({ ok: true, rows: [] }),
    trash: async () => ({ ok: false, reason: 'journal-corrupt' }),
  })
  assert.equal(json.ok, false)
  assert.equal(json.reason, 'journal-corrupt', '不能假装回收箱是空的')
})

test('4.5 · 服务层带路径的 reason 不会原样出网', async () => {
  const { text } = await getTrash({
    list: async () => ({ ok: true, rows: [] }),
    trash: async () => ({ ok: false, reason: 'C:/secret/trash/x ENOENT' }),
  })
  assert.equal(text.includes('secret'), false)
  assert.equal(text.includes('ENOENT'), false)
})

test('4.5 · 响应带 maxProtected', async () => {
  const { json } = await getTrash({
    list: async () => ({ ok: true, rows: [] }),
    trash: async () => ({ ok: true, rows: [], protectedCount: 3, keptDays: 7, maxProtected: 200 }),
  })
  assert.equal(json.maxProtected, 200)
  assert.equal(json.protectedCount, 3)
})
