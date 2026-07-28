import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncQueue } from '../src/async.js'

test('AsyncQueue yields an explicitly queued undefined value', async () => {
  const queue = new AsyncQueue<undefined>()
  queue.push(undefined)
  queue.close()
  const iterator = queue[Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), { value: undefined, done: false })
  assert.deepEqual(await iterator.next(), { value: undefined, done: true })
})
