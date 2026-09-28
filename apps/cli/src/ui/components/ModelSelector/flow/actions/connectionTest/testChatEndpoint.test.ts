import { describe, expect, test } from 'bun:test'

import { testChatEndpoint } from './testChatEndpoint'
import type { ConnectionTestResult } from './types'

type CapturedRequest = {
  tool_choice: unknown
  messages: Array<{ role: string; content: string }>
}

const FORCED_TOOL_CHOICE = { type: 'function', function: { name: 'Write' } }
const TEST_TIMEOUT_MS = 20_000

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rejectedToolChoiceResponse(): Response {
  return jsonResponse(
    {
      error: {
        message: 'Thinking mode does not support this tool_choice',
        type: 'invalid_request_error',
      },
    },
    400,
  )
}

function textOnlyResponse(): Response {
  return jsonResponse({
    choices: [
      { message: { role: 'assistant', content: 'I will not call any tool.' } },
    ],
  })
}

async function runTestChatEndpoint(
  respond: (request: CapturedRequest) => Response,
  overrides?: { selectedModel?: string },
): Promise<{ requests: CapturedRequest[]; result: ConnectionTestResult }> {
  const requests: CapturedRequest[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as CapturedRequest
    requests.push(request)
    return respond(request)
  }) as unknown as typeof fetch

  try {
    const result = await testChatEndpoint({
      baseURL: 'https://api.deepseek.com',
      endpointPath: '/chat/completions',
      endpointName: 'Standard OpenAI',
      selectedProvider: 'deepseek',
      selectedModel: overrides?.selectedModel ?? 'deepseek-reasoner',
      apiKey: 'test-api-key',
      maxTokens: '8192',
      requestHeadersProfile: 'kode',
      systemPromptProfile: 'kode',
      fallbackStepName: 'kode-default',
    })
    return { requests, result }
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('testChatEndpoint tool_choice downgrade', () => {
  test(
    'retries with tool_choice auto when the provider rejects the forced tool choice',
    async () => {
      const { requests, result } = await runTestChatEndpoint(request =>
        request.tool_choice === 'auto'
          ? textOnlyResponse()
          : rejectedToolChoiceResponse(),
      )

      expect(requests).toHaveLength(2)
      expect(requests[0]!.tool_choice).toEqual(FORCED_TOOL_CHOICE)
      expect(requests[1]!.tool_choice).toBe('auto')
      // The downgraded request is evaluated as a model response instead of the
      // rejected forced tool choice being surfaced as the connection failure.
      expect(result.message).toBe(
        'Standard OpenAI connected but tool-use verification failed',
      )
      expect(result.errorCategory).toBe('tool_use_unsupported')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'does not downgrade the tool choice for unrelated 400 responses',
    async () => {
      const { requests, result } = await runTestChatEndpoint(
        () => jsonResponse({ error: { message: 'Model Not Exist' } }, 400),
        { selectedModel: 'deepseek-unknown' },
      )

      expect(requests).toHaveLength(1)
      expect(result.success).toBe(false)
      expect(result.message).toBe('Standard OpenAI failed (400)')
      expect(result.details).toBe('Error: Model Not Exist')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'surfaces the failure when the downgraded request also fails',
    async () => {
      const { requests, result } = await runTestChatEndpoint(() =>
        rejectedToolChoiceResponse(),
      )

      expect(requests).toHaveLength(2)
      expect(requests[1]!.tool_choice).toBe('auto')
      expect(result.success).toBe(false)
      expect(result.details).toBe(
        'Error: Thinking mode does not support this tool_choice',
      )
    },
    TEST_TIMEOUT_MS,
  )
})
