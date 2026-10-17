/**
 * S3 · the restored-draft notice strip.
 *
 * The strip is the part the user actually perceives, so it gets its own tests:
 * the bus lifecycle, the identity rule that keeps a notice out of the wrong
 * composer, and the tracking that lets the switch remove it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createNoticeBus,
  isMyNotice,
  previewOf,
  mountNotice,
  NS,
  NOTICE_SLOT,
  NOTICE_ID,
  ZH,
  EN,
} from '../src/client/features/draft-notice.js'

test('the bus remembers the newest notice and clears on null', () => {
  const bus = createNoticeBus()
  assert.equal(bus.get(), null)
  bus.publish({ chars: 5, text: 'hello' })
  assert.equal(bus.get().chars, 5)
  bus.publish(null)
  assert.equal(bus.get(), null)
})

test('subscribers are notified and can unsubscribe', () => {
  const bus = createNoticeBus()
  let calls = 0
  const off = bus.subscribe(() => {
    calls += 1
  })
  bus.publish({ chars: 1, text: 'a' })
  assert.equal(calls, 1)
  off()
  bus.publish({ chars: 2, text: 'b' })
  assert.equal(calls, 1)
})

test('a throwing listener cannot break the others', () => {
  const bus = createNoticeBus()
  let seen = 0
  bus.subscribe(() => {
    throw new Error('boom')
  })
  bus.subscribe(() => {
    seen += 1
  })
  assert.doesNotThrow(() => bus.publish({ chars: 1, text: 'x' }))
  assert.equal(seen, 1)
})

test('dispose clears the listeners and the notice', () => {
  const bus = createNoticeBus()
  let calls = 0
  bus.subscribe(() => {
    calls += 1
  })
  bus.publish({ chars: 1, text: 'x' })
  bus.dispose()
  assert.equal(bus.get(), null)
  bus.publish({ chars: 2, text: 'y' })
  assert.equal(calls, 1, 'a disposed bus notifies nobody')
})

test('the notice belongs only to the draft it restored', () => {
  const snapshot = { text: 'restored text', chars: 13 }
  assert.equal(isMyNotice(snapshot, 'restored text'), true)
  assert.equal(isMyNotice(snapshot, 'restored text plus typing'), true, 'typing after it keeps the strip')
  assert.equal(isMyNotice(snapshot, 'a different draft'), false, 'another composer stays quiet')
  assert.equal(isMyNotice(snapshot, ''), false, 'an emptied draft has nothing to say')
  assert.equal(isMyNotice(snapshot, null), false, 'an unknown draft never matches')
  assert.equal(isMyNotice(null, 'restored text'), false)
  assert.equal(isMyNotice({ text: '', chars: 0 }, ''), false, 'an empty restore is not a restoration')
})

test('previewOf flattens whitespace and truncates', () => {
  assert.equal(previewOf('a\n b   c'), 'a b c')
  const long = 'x'.repeat(80)
  const preview = previewOf(long)
  assert.equal(preview.length, 61, '60 characters plus the ellipsis')
  assert.ok(preview.endsWith('…'))
})

test('both dictionaries cover every key the strip asks for', () => {
  const keys = ['notice', 'copy', 'copied', 'copyFailed', 'clear', 'dismiss', 'hint']
  for (const key of keys) {
    assert.equal(typeof ZH[key], 'string', 'zh.' + key)
    assert.equal(typeof EN[key], 'string', 'en.' + key)
  }
})

test('mountNotice registers two dictionaries and one slot, all disposable', () => {
  const events = []
  const disposals = []
  const ctx = {
    locale: {
      register: (ns, lang) => {
        events.push('locale:' + ns + ':' + lang)
        return () => disposals.push('locale:' + lang)
      },
      bind: () => (key, params) => key + (params ? ':' + params.chars : ''),
    },
    slots: {
      inject: (slot, callback) => {
        events.push('inject:' + slot)
        return callback()
      },
      register: (options) => {
        events.push('register:' + options.id)
        return () => disposals.push(options.id)
      },
    },
    effect: (fn) => {
      const result = fn()
      return typeof result === 'function' ? result : () => {}
    },
  }
  const tracked = []
  const env = { track: (value) => { tracked.push(value); return value } }
  const bus = createNoticeBus()

  mountNotice(ctx, env, bus)

  assert.ok(events.includes('locale:' + NS + ':zh'))
  assert.ok(events.includes('locale:' + NS + ':en'))
  assert.ok(events.includes('inject:' + NOTICE_SLOT))
  assert.ok(events.includes('register:' + NOTICE_ID))
  assert.equal(tracked.length, 3, 'two dictionaries + one slot registration are tracked')

  for (const dispose of tracked) dispose()
  assert.equal(disposals.length, 3, 'every registration has a working disposer')
})
