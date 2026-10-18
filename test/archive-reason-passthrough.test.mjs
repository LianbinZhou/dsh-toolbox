/**
 * 第三刀：服务层的稳定原因码要能到达前端。
 *
 * 以前 HTTP 层一律回 `delete refused`，前端只能显示笼统的「操作失败」。
 * 这里锁两件事：已知码原样透传；任何可疑内容（路径、异常原文）绝不出现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createDeleteHandler } from '../src/host/features/archive/route-guard.js'

const ALLOW = { authorize: () => ({ ok: true }) }

async function callDelete(reason, extra = {}) {
  const handler = createDeleteHandler({
    guard: ALLOW,
    onDelete: async () => ({ ok: false, reason, ...extra }),
    peerOf: () => '127.0.0.1',
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const body = JSON.stringify({ sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444' })
  const response = await new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/archive-manager/delete', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-toolbox': '1', 'x-dsh-toolbox-token': 'x'.repeat(64) } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.write(body)
    req.end()
  })
  await new Promise((resolve) => server.close(resolve))
  return { status: response.status, json: JSON.parse(response.text), text: response.text }
}

test('reason · 已知码原样透传（live / trash-full / journal-corrupt）', async () => {
  for (const reason of ['live', 'trash-full', 'journal-corrupt']) {
    const { status, json } = await callDelete(reason)
    assert.equal(status, 409)
    assert.equal(json.reason, reason, '前端要靠它显示具体提示')
  }
})

test('reason · 可疑内容一律变成 request-failed，且响应里没有路径', async () => {
  const { json, text } = await callDelete('../../etc/passwd: ENOENT at C:\\Users\\x')
  assert.equal(json.reason, 'request-failed')
  assert.equal(/passwd|ENOENT|Users/i.test(text), false, '绝不能把路径或异常原文送出去')
})

test('reason · 未知码不原样透传', async () => {
  const { json } = await callDelete('some-internal-thing')
  assert.equal(json.reason, 'request-failed')
})
