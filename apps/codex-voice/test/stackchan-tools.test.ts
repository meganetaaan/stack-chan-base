import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { JsonLineRpcConnection } from '../src/codex/rpc.js'
import {
  STACKCHAN_DYNAMIC_TOOLS,
  StackChanToolHandler,
} from '../src/tools/stackchan.js'

test('fixed Stack-chan tool definition exposes a read-only namespaced status tool', () => {
  assert.deepEqual(STACKCHAN_DYNAMIC_TOOLS, [
    {
      type: 'namespace',
      name: 'stackchan',
      description: 'ｽﾀｯｸﾁｬﾝ本体の安全な状態確認ツール',
      tools: [
        {
          type: 'function',
          name: 'get_status',
          description: 'USB接続状態と現在の会話状態を取得する。状態は変更しない。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
  ])
})

test('stackchan.get_status returns current device and conversation state', async () => {
  const output = new PassThrough()
  const rpc = new JsonLineRpcConnection(new PassThrough(), output)
  const handler = new StackChanToolHandler(rpc, 'thread-1', () => ({
    connected: true,
    conversationState: 'listening',
    desired: true,
  }))
  const response = once(output, 'data')
  await handler.handleServerRequest({
    id: 'request-1',
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'stackchan',
      tool: 'get_status',
      arguments: {},
    },
  })
  const [line] = await response
  assert.deepEqual(JSON.parse(String(line)), {
    id: 'request-1',
    result: {
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: '{"connected":true,"conversationState":"listening","desired":true}',
        },
      ],
    },
  })
})

for (const testCase of [
  {
    name: 'another thread',
    params: {
      threadId: 'thread-2',
      namespace: 'stackchan',
      tool: 'get_status',
      arguments: {},
    },
    expected: /another thread/,
  },
  {
    name: 'unknown tool',
    params: {
      threadId: 'thread-1',
      namespace: 'stackchan',
      tool: 'set_emotion',
      arguments: {},
    },
    expected: /unknown Stack-chan tool/,
  },
  {
    name: 'arguments',
    params: {
      threadId: 'thread-1',
      namespace: 'stackchan',
      tool: 'get_status',
      arguments: { verbose: true },
    },
    expected: /does not accept arguments/,
  },
] as const) {
  test(`stackchan.get_status safely rejects ${testCase.name}`, async () => {
    const output = new PassThrough()
    const rpc = new JsonLineRpcConnection(new PassThrough(), output)
    const handler = new StackChanToolHandler(rpc, 'thread-1', () => ({
      connected: true,
      conversationState: 'standby',
      desired: false,
    }))
    const response = once(output, 'data')
    await handler.handleServerRequest({
      id: 'request-1',
      method: 'item/tool/call',
      params: testCase.params,
    })
    const [line] = await response
    const result = JSON.parse(String(line)) as {
      result: { success: boolean; contentItems: Array<{ text: string }> }
    }
    assert.equal(result.result.success, false)
    assert.match(result.result.contentItems[0]!.text, testCase.expected)
  })
}
