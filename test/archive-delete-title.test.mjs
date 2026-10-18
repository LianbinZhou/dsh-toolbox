/**
 * 删除请求里的标题必须真的传到服务层。
 *
 * 这条测试存在的理由：上一版 route-guard 的替换没落进去，
 * 界面显示正常、journal 里却没有 title，回收箱只能显示 id 尾段。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createDeleteHandler } from '../src/host/features/archive/route-guard.js'

const ALLOW = { authorize: () => ({ ok: true }) }

async function postDelete(body) {
  const seen = []
  const handler = createDeleteHandler({
    guard: ALLOW,
    onDelete: async (id, options) => {
      seen.push({ id, options })
      return { ok: true, movedToTrash: true, recoverable: true, keptDays: 7 }
    },
    peerOf: () => '127.0.0.1',
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/archive-manager/delete', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-toolbox': '1', 'x-dsh-toolbox-token': 'x'.repeat(64) } },
      (res) => { res.resume(); res.on('end', resolve) },
    )
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
  await new Promise((resolve) => server.close(resolve))
  return seen
}

const ID = 'session-aaaaaaaa-1111-2222-3333-444444444444'

test('title · 请求体里的标题会传给服务层', async () => {
  const seen = await postDelete({ sessionId: ID, title: 'modlens 提示欠费原因排查' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].id, ID)
  assert.equal(seen[0].options.title, 'modlens 提示欠费原因排查', '标题必须到服务层，否则回收箱只有 id')
})

test('title · 超长标题被截断', async () => {
  const seen = await postDelete({ sessionId: ID, title: 'x'.repeat(500) })
  assert.equal(seen[0].options.title.length, 120)
})

test('title · 不是字符串的标题被丢掉', async () => {
  const seen = await postDelete({ sessionId: ID, title: { evil: 'C:/secret' } })
  assert.equal(seen[0].options.title, undefined)
})
