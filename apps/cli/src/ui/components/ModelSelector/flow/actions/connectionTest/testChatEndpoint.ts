import type { ProviderType } from '#core/utils/config'
import { debug as debugLogger } from '#core/utils/debugLogger'
import type { ConnectionTestResult } from './types'
import {
  buildCompatHeaders,
  classifyRequestFailure,
  type RequestHeadersProfile,
  type SystemPromptProfile,
  COMPAT_TOOL_ALLOWLIST,
} from '#core/ai/llm/restrictedClientCompat'
import {
  getCLISyspromptPrefix,
  getCompatSyspromptPrefix,
  getCompatSystemPrompt,
  getSystemPrompt,
} from '#core/constants/prompts'
import { randomUUID } from 'crypto'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function extractOpenAIToolCall(data: unknown): {
  toolName: string
  args: Record<string, unknown>
} | null {
  const record = asRecord(data)
  if (!record) return null

  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return null

  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  if (!message) return null

  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const firstCall = asRecord(toolCalls[0])
    const fn = asRecord(firstCall?.function)
    const toolName = typeof fn?.name === 'string' ? fn.name : null
    const rawArgs = fn?.arguments
    if (!toolName) return null

    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs) as unknown
        const args = asRecord(parsed)
        if (!args) return null
        return { toolName, args }
      } catch {
        return null
      }
    }

    const args = asRecord(rawArgs)
    if (!args) return null
    return { toolName, args }
  }

  const functionCall = asRecord(message.function_call)
  if (functionCall) {
    const toolName =
      typeof functionCall.name === 'string' ? functionCall.name : null
    const rawArgs = functionCall.arguments
    if (!toolName) return null
    if (typeof rawArgs !== 'string') return null
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      const args = asRecord(parsed)
      if (!args) return null
      return { toolName, args }
    } catch {
      return null
    }
  }

  return null
}

function extractOpenAITextContent(data: unknown): string {
  const record = asRecord(data)
  if (record && Array.isArray(record.choices) && record.choices.length > 0) {
    const firstChoice = asRecord(record.choices[0])
    const message = asRecord(firstChoice?.message)
    const content = message?.content
    if (typeof content === 'string') return content
  }
  if (record && typeof record.reply === 'string') return record.reply
  if (record && record.output) {
    const output = asRecord(record.output)
    const text = output?.text ?? record.output
    return typeof text === 'string' ? text : String(text ?? '')
  }
  return ''
}

function extractErrorMessage(errorData: unknown): string | null {
  const record = asRecord(errorData)
  if (!record) return null

  const nestedError = asRecord(record.error)
  if (nestedError && typeof nestedError.message === 'string') {
    return nestedError.message
  }
  if (typeof record.message === 'string') return record.message
  if (typeof record.error === 'string') return record.error
  return null
}

// Thinking/reasoning modes (for example DeepSeek's reasoning models) reject a named
// `tool_choice` with a 400 while still supporting tool use when the model picks the
// tool itself.
const FORCED_TOOL_CHOICE_REJECTION_HINTS = [
  'tool_choice',
  'tool choice',
  'toolchoice',
]

function isForcedToolChoiceRejection(errorData: unknown): boolean {
  const message = extractErrorMessage(errorData)
  if (!message) return false
  const normalized = message.toLowerCase()
  return FORCED_TOOL_CHOICE_REJECTION_HINTS.some(hint =>
    normalized.includes(hint),
  )
}

async function buildSystemMessageContent(args: {
  model: string
  systemPromptProfile: SystemPromptProfile
}): Promise<string> {
  const prefix =
    args.systemPromptProfile === 'compat'
      ? getCompatSyspromptPrefix()
      : getCLISyspromptPrefix()

  const promptBlocks =
    args.systemPromptProfile === 'compat'
      ? await getCompatSystemPrompt({
          model: args.model,
          toolNames: Array.from(COMPAT_TOOL_ALLOWLIST),
        })
      : await getSystemPrompt()

  return [prefix, ...promptBlocks].join('\n')
}

export async function testChatEndpoint({
  baseURL,
  endpointPath,
  endpointName,
  selectedProvider,
  selectedModel,
  apiKey,
  maxTokens,
  requestHeadersProfile,
  systemPromptProfile,
  fallbackStepName,
  onProgress,
}: {
  baseURL: string
  endpointPath: string
  endpointName: string
  selectedProvider: ProviderType
  selectedModel: string
  apiKey: string
  maxTokens: string
  requestHeadersProfile: RequestHeadersProfile
  systemPromptProfile: SystemPromptProfile
  fallbackStepName: string
  onProgress?: (result: ConnectionTestResult) => void
}): Promise<ConnectionTestResult> {
  const testURL = `${baseURL.replace(/\/+$/, '')}${endpointPath}`

  const networkRetryCount = 3
  const timeoutMs = 45_000

  for (let attempt = 1; attempt <= 1 + networkRetryCount; attempt++) {
    const attemptLabel = `${attempt}/${1 + networkRetryCount}`

    onProgress?.({
      success: false,
      phase: 'request',
      attempt,
      maxAttempts: 1 + networkRetryCount,
      message: `Sending tool-use request to ${endpointName} (${attemptLabel})...`,
      endpoint: endpointPath,
      fallbackStep: fallbackStepName,
    })

    const tempDir = await mkdtemp(join(tmpdir(), 'kode-model-test-'))
    const expectedContent = `KODE_MODEL_TEST_OK:${randomUUID()}`
    const expectedFilePath = join(tempDir, 'write-tool-test.txt')

    try {
      const system = await buildSystemMessageContent({
        model: selectedModel,
        systemPromptProfile,
      })

      const userPrompt = `You are being tested for tool-use support.

You MUST call the Write tool exactly once with:
- file_path: ${expectedFilePath}
- content: ${expectedContent}

Do NOT include any other text. Do NOT call any other tool.`

      const tools = [
        {
          type: 'function',
          function: {
            name: 'Write',
            description: 'Write a file to the local filesystem',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file_path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['file_path', 'content'],
            },
          },
        },
      ]

      const forcedToolChoice = {
        type: 'function',
        function: { name: 'Write' },
      }

      const testPayload: Record<string, unknown> = {
        model: selectedModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
        tools,
        tool_choice: forcedToolChoice,
        max_tokens: Math.max(parseInt(maxTokens) || 1024, 256),
        temperature: 0,
        stream: false,
      }

      if (selectedModel && selectedModel.toLowerCase().includes('gpt-5')) {
        debugLogger.api('GPT5_PARAMETER_FIX_APPLY', { model: selectedModel })

        if (typeof testPayload.max_tokens === 'number') {
          testPayload.max_completion_tokens = testPayload.max_tokens
          delete testPayload.max_tokens
          debugLogger.api('GPT5_PARAMETER_FIX_MAX_TOKENS', {
            model: selectedModel,
            max_completion_tokens: testPayload.max_completion_tokens,
          })
        }

        if (
          typeof testPayload.temperature === 'number' &&
          testPayload.temperature !== 1
        ) {
          debugLogger.api('GPT5_PARAMETER_FIX_TEMPERATURE', {
            model: selectedModel,
            from: testPayload.temperature,
            to: 1,
          })
          testPayload.temperature = 1
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(requestHeadersProfile === 'compat' ? buildCompatHeaders() : {}),
      }

      if (selectedProvider === 'azure') {
        headers['api-key'] = apiKey
      } else {
        headers.Authorization = `Bearer ${apiKey}`
      }

      const sendRequest = async (toolChoice: unknown): Promise<Response> =>
        await fetchWithTimeout(
          testURL,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...testPayload, tool_choice: toolChoice }),
          },
          timeoutMs,
        )

      let response = await sendRequest(forcedToolChoice)
      let errorData: unknown = null

      if (!response.ok && response.status === 400) {
        const rejectionData = (await response
          .json()
          .catch(() => null)) as unknown

        if (isForcedToolChoiceRejection(rejectionData)) {
          debugLogger.api('CONNECTION_TEST_TOOL_CHOICE_DOWNGRADE', {
            provider: selectedProvider,
            endpoint: endpointPath,
            model: selectedModel,
            status: response.status,
          })

          onProgress?.({
            success: false,
            phase: 'request',
            attempt,
            maxAttempts: 1 + networkRetryCount,
            message: `${endpointName} rejected the forced tool choice; retrying with tool_choice "auto"...`,
            endpoint: endpointPath,
            fallbackStep: fallbackStepName,
          })

          response = await sendRequest('auto')
        } else {
          errorData = rejectionData
        }
      }

      if (!response.ok) {
        if (errorData === null) {
          errorData = (await response.json().catch(() => null)) as unknown
        }
        const errorMessage =
          extractErrorMessage(errorData) ||
          response.statusText ||
          `HTTP ${response.status}`

        const syntheticError = Object.assign(new Error(errorMessage), {
          status: response.status,
        })
        const classified = classifyRequestFailure(syntheticError, {
          modelName: selectedModel,
        })
        const errorCategory =
          response.status >= 500
            ? 'network'
            : classified.kind === 'restricted_client_only'
              ? 'restricted_client_only'
              : classified.kind

        const result: ConnectionTestResult = {
          success: false,
          message: `${endpointName} failed (${response.status})`,
          endpoint: endpointPath,
          details: `Error: ${errorMessage}`,
          errorCategory,
          fallbackStep: fallbackStepName,
        }

        if (errorCategory === 'network' && attempt <= networkRetryCount) {
          const retryInMs = attempt * 5000
          onProgress?.({
            ...result,
            phase: 'retry_wait',
            attempt,
            maxAttempts: 1 + networkRetryCount,
            retryInMs,
            message: `${result.message} — retrying in ${Math.round(retryInMs / 1000)}s...`,
          })
          await sleep(retryInMs)
          continue
        }

        return result
      }

      const data = (await response.json()) as unknown
      debugLogger.api('CONNECTION_TEST_RESPONSE', {
        provider: selectedProvider,
        endpoint: endpointPath,
        ok: true,
      })

      const toolCall = extractOpenAIToolCall(data)
      if (!toolCall) {
        const responseContent = extractOpenAITextContent(data).trim()
        return {
          success: false,
          message: `${endpointName} connected but tool-use verification failed`,
          endpoint: endpointPath,
          errorCategory: 'tool_use_unsupported',
          fallbackStep: fallbackStepName,
          details:
            responseContent.length > 0
              ? `Model did not call the Write tool. Response: "${responseContent}"\n\nThis usually means the model/provider does not support tool use reliably. Try a newer/stronger model (e.g. glm4.7, minimax2.1, claude sonnet 4.5) or change request strategy.`
              : 'Model did not call the Write tool and returned an empty response.\n\nThis usually means the model/provider does not support tool use reliably. Try a newer/stronger model (e.g. glm4.7, minimax2.1, claude sonnet 4.5) or change request strategy.',
        }
      }

      if (toolCall.toolName !== 'Write') {
        return {
          success: false,
          message: `${endpointName} returned unexpected tool call`,
          endpoint: endpointPath,
          errorCategory: 'unexpected_tool_call',
          fallbackStep: fallbackStepName,
          details: `Expected tool "Write" but got "${toolCall.toolName}"`,
        }
      }

      const filePath = toolCall.args.file_path
      const content = toolCall.args.content
      if (typeof filePath !== 'string' || typeof content !== 'string') {
        return {
          success: false,
          message: `${endpointName} tool call arguments invalid`,
          endpoint: endpointPath,
          errorCategory: 'invalid_tool_args',
          fallbackStep: fallbackStepName,
          details: `Expected {file_path: string, content: string} but got: ${JSON.stringify(toolCall.args)}`,
        }
      }

      if (filePath !== expectedFilePath || content !== expectedContent) {
        return {
          success: false,
          message: `${endpointName} tool call arguments mismatch`,
          endpoint: endpointPath,
          errorCategory: 'invalid_tool_args',
          fallbackStep: fallbackStepName,
          details: `Expected file_path="${expectedFilePath}" and exact content match, but got file_path="${filePath}" content="${content}"`,
        }
      }

      // Execute the requested tool call locally via the actual Write tool implementation.
      const writeContext = {
        messageId: 'model-connection-test',
        abortController: new AbortController(),
        readFileTimestamps: {} as Record<string, number>,
      } as const

      const writeGen = FileWriteTool.call(
        { file_path: expectedFilePath, content: expectedContent },
        writeContext as any,
      )
      for await (const step of writeGen) {
        if (step.type === 'result') break
      }

      const actual = await readFile(expectedFilePath, 'utf8')
      if (actual !== expectedContent) {
        return {
          success: false,
          message: `${endpointName} local file verification failed`,
          endpoint: endpointPath,
          errorCategory: 'local_verification_failed',
          fallbackStep: fallbackStepName,
          details: `File content mismatch after write; expected "${expectedContent}" but got "${actual}"`,
        }
      }

      return {
        success: true,
        message: `Tool-use connection test passed with ${endpointName}`,
        endpoint: endpointPath,
        fallbackStep: fallbackStepName,
        details: `Model successfully called Write and the file was verified: ${expectedFilePath}`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const classified = classifyRequestFailure(error, {
        modelName: selectedModel,
      })
      const errorCategory = message.toLowerCase().includes('abort')
        ? 'timeout'
        : classified.kind

      const result: ConnectionTestResult = {
        success: false,
        message: `${endpointName} connection failed`,
        endpoint: endpointPath,
        details: message,
        errorCategory,
        fallbackStep: fallbackStepName,
      }

      if (
        (errorCategory === 'network' || errorCategory === 'timeout') &&
        attempt <= networkRetryCount
      ) {
        const retryInMs = attempt * 5000
        onProgress?.({
          ...result,
          phase: 'retry_wait',
          attempt,
          maxAttempts: 1 + networkRetryCount,
          retryInMs,
          message: `${result.message} — retrying in ${Math.round(retryInMs / 1000)}s...`,
        })
        await sleep(retryInMs)
        continue
      }

      return result
    } finally {
      // Best-effort cleanup. The temp directory is used only for this connection test.
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  return {
    success: false,
    message: `${endpointName} connection failed`,
    endpoint: endpointPath,
    details: 'Exhausted retries',
    errorCategory: 'network',
    fallbackStep: fallbackStepName,
  }
}
