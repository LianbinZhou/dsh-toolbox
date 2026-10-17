import test from 'node:test'
import assert from 'node:assert/strict'
import { createScope } from '../src/client/scope.js'

test('track returns the disposer and dispose runs everything newest-first', () => {
  const order = []
  const scope = createScope('t1')
  scope.track(() => order.push('a'))
  scope.track(() => order.push('b'))
  assert.equal(scope.size(), 2)
  scope.dispose()
  assert.deepEqual(order, ['b', 'a'], 'disposers must run in reverse registration order')
  assert.equal(scope.size(), 0)
})

test('a throwing disposer never stops the others (independent try/catch)', () => {
  const order = []
  const scope = createScope('t2')
  scope.track(() => order.push('last'))
  scope.track(() => {
    throw new Error('boom')
  })
  scope.track(() => order.push('first'))
  assert.throws(() => scope.dispose(), /boom/, 'the first failure surfaces after every disposer ran')
  assert.deepEqual(order, ['first', 'last'])
})

test('dispose is idempotent: a second teardown runs nothing', () => {
  let runs = 0
  const scope = createScope('t3')
  scope.track(() => {
    runs += 1
  })
  scope.dispose()
  scope.dispose()
  scope.dispose()
  assert.equal(runs, 1)
})

test('tracking after dispose undoes immediately instead of accumulating', () => {
  let runs = 0
  const scope = createScope('t4')
  scope.dispose()
  scope.track(() => {
    runs += 1
  })
  assert.equal(runs, 1, 'a late disposer must run at once')
  assert.equal(scope.size(), 0)
})

test('a Cordis fiber is accepted as a disposable', () => {
  let disposed = 0
  const fiber = { dispose: () => (disposed += 1) }
  const scope = createScope('t5')
  scope.track(fiber)
  scope.dispose()
  assert.equal(disposed, 1)
})

test('P1-6: the same disposer tracked twice (return value + env.track) runs once', () => {
  let runs = 0
  const disposer = () => {
    runs += 1
  }
  const scope = createScope('t6')
  scope.track(disposer)
  scope.track(disposer)
  assert.equal(scope.size(), 1, 'identity de-duplication keeps one entry')
  scope.dispose()
  assert.equal(runs, 1)
})

test('P1-5: an async fiber disposal is awaited by dispose() and never rejects unhandled', async () => {
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)

  let settled = false
  const scope = createScope('t7')
  scope.track({
    dispose: () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => {
          settled = true
          reject(new Error('async dispose failed'))
        }, 5)
      }),
  })

  const pending = scope.dispose()
  assert.ok(pending && typeof pending.then === 'function', 'dispose returns a promise')
  await pending
  assert.equal(settled, true, 'the async disposal really finished')

  await new Promise((resolve) => setTimeout(resolve, 20))
  process.off('unhandledRejection', onRejection)
  assert.equal(rejections.length, 0, 'the rejection was caught, not left unhandled')
})

test('a non-disposable is rejected loudly', () => {
  const scope = createScope('t8')
  assert.throws(() => scope.track({ notADisposer: true }), TypeError)
  assert.throws(() => scope.track(42), TypeError)
  assert.equal(scope.size(), 0)
})

test('null and undefined are ignored', () => {
  const scope = createScope('t9')
  scope.track(undefined)
  scope.track(null)
  assert.equal(scope.size(), 0)
})
