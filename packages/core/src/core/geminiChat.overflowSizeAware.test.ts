/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Size-aware reactive-overflow gate. Two non-tautological cases that differ
// ONLY by the size of the pending prompt relative to the model window:
//
//  1. size-detected overflow recovers: the mock content generator throws an
//     OPAQUE `400 "Error from inference-provider"` (NOT a recognised overflow
//     text) while the prompt is oversized (estimated tokens > window). The
//     broadened gate must recognise this via `isLikelyContextOverflow`'s size
//     branch and drive exactly one reactive tryCompress(force=true) + a RETRY.
//
//  2. no false positive: the SAME opaque 400 with a normal-sized context
//     (estimated tokens <= window) must NOT trigger reactive compression; the
//     error propagates unchanged.
//
// To reach the *reactive* gate while the prompt is genuinely oversized, the
// pre-send hard-tier rescue is disabled by pre-latching the hard-rescue
// breaker (hardRescueFailureCount = MAX_CONSECUTIVE_FAILURES). This mirrors the
// exact real-world path the reactive net is designed for: the code logs
// "hard-tier rescue skipped ...; relying on reactive overflow recovery"
// (geminiChat.ts ~line 1889), lets the oversized send go out, and depends on
// the reactive gate to catch the provider rejection. The breaker is latched in
// BOTH cases so the only difference between them is the prompt size
// (lastPromptTokenCount) — in the normal-sized case the breaker is inert
// because the prompt never reaches the hard tier.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Content, GenerateContentResponse } from '@google/genai';
import { type ContentGenerator } from '../core/contentGenerator.js';
import { GeminiChat, StreamEventType, type StreamEvent } from './geminiChat.js';
import type { Config } from '../config/config.js';
import { setSimulate429 } from '../utils/testUtils.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { CompressionStatus } from './turn.js';
import {
  ChatCompressionService,
  MAX_CONSECUTIVE_FAILURES,
} from '../services/chatCompressionService.js';

// Mock fs to prevent real file-system writes from the chat-recording service.
const mockFileSystem = new Map<string, string>();
vi.mock('node:fs', () => {
  const fsModule = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((path: string, data: string) => {
      mockFileSystem.set(path, data);
    }),
    readFileSync: vi.fn((path: string) => {
      if (mockFileSystem.has(path)) {
        return mockFileSystem.get(path);
      }
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
    }),
    existsSync: vi.fn((path: string) => mockFileSystem.has(path)),
    appendFileSync: vi.fn(),
  };
  return { default: fsModule, ...fsModule };
});

// retryWithBackoff: pass through so a rejected send surfaces immediately at the
// reactive gate instead of looping through real backoff.
const { mockRetryWithBackoff } = vi.hoisted(() => ({
  mockRetryWithBackoff: vi.fn(),
}));
vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, retryWithBackoff: mockRetryWithBackoff };
});

vi.mock('../telemetry/loggers.js', () => ({
  logContentRetry: vi.fn(),
  logContentRetryFailure: vi.fn(),
  logChatCompression: vi.fn(),
}));

vi.mock('../telemetry/uiTelemetry.js', () => ({
  uiTelemetryService: {
    setLastPromptTokenCount: vi.fn(),
    setLastCachedContentTokenCount: vi.fn(),
  },
}));

const { mockAcquireSleepInhibitor, mockSleepInhibitorRelease } = vi.hoisted(
  () => ({
    mockAcquireSleepInhibitor: vi.fn(),
    mockSleepInhibitorRelease: vi.fn(),
  }),
);
vi.mock('../services/sleepInhibitor.js', () => ({
  acquireSleepInhibitor: mockAcquireSleepInhibitor,
}));

describe('geminiChat size-aware reactive overflow', () => {
  let mockContentGenerator: ContentGenerator;
  let chat: GeminiChat;
  let mockConfig: Config;

  // The opaque provider rejection that carries NO recognisable overflow text.
  const opaqueProviderError = () =>
    Object.assign(new Error('Error from inference-provider'), { status: 400 });

  function makeStreamResponse(text = 'ok') {
    return (async function* () {
      yield {
        candidates: [
          {
            content: { parts: [{ text }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
            safetyRatings: [],
          },
        ],
        text: () => text,
      } as unknown as GenerateContentResponse;
    })();
  }

  // The window every case runs against. `estimatedPromptTokens > CONTEXT_WINDOW`
  // is what the size branch keys on.
  const CONTEXT_WINDOW = 100_000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireSleepInhibitor.mockReturnValue({
      release: mockSleepInhibitorRelease,
    });
    mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());

    mockContentGenerator = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      countTokens: vi.fn(),
      embedContent: vi.fn(),
      batchEmbedContents: vi.fn(),
      useSummarizedThinking: vi.fn().mockReturnValue(false),
    } as unknown as ContentGenerator;

    mockConfig = {
      getModelRouteIdentity: vi.fn().mockReturnValue('gemini-pro@test0001'),
      getSessionId: () => 'test-session-id',
      getTelemetryLogPromptsEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        model: 'test-model',
        contextWindowSize: CONTEXT_WINDOW,
      }),
      getModel: vi.fn().mockReturnValue('test-model'),
      setModel: vi.fn(),
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getTargetDir: vi.fn().mockReturnValue('/test/project/root'),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/temp'),
      },
      getToolRegistry: vi.fn().mockReturnValue({ getTool: vi.fn() }),
      getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
      getBaseLlmClient: vi.fn().mockReturnValue(undefined),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getAutoCompactThreshold: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getFileReadCache: vi.fn().mockReturnValue({ clear: vi.fn() }),
      getClearContextOnIdle: vi.fn().mockReturnValue({
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 5,
        toolResultsTotalCharsThreshold: 500_000,
      }),
      getEffectiveInputModalities: vi.fn().mockReturnValue({}),
      getModelFallbacks: vi.fn().mockReturnValue([]),
      assertCanStartTurn: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;

    setSimulate429(false);
    chat = new GeminiChat(mockConfig, {}, [], undefined, uiTelemetryService);
    // Latch the hard-rescue breaker so the pre-send hard-tier rescue is skipped
    // and an oversized send is allowed to reach the reactive gate (see header).
    (
      chat as unknown as { hardRescueFailureCount: number }
    ).hardRescueFailureCount = MAX_CONSECUTIVE_FAILURES;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('reactively compresses on an opaque 400 when the prompt exceeds the window', async () => {
    // Prompt estimated well ABOVE the window → the size branch of
    // isLikelyContextOverflow must fire even though the error text is opaque.
    chat.setLastPromptTokenCount(150_000);

    const compressedHistory: Content[] = [
      { role: 'user', parts: [{ text: 'summary' }] },
      { role: 'model', parts: [{ text: 'ack' }] },
      { role: 'user', parts: [{ text: 'latest' }] },
    ];
    const compressSpy = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        newHistory: compressedHistory,
        info: {
          originalTokenCount: 150_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });

    vi.mocked(mockContentGenerator.generateContentStream)
      .mockRejectedValueOnce(opaqueProviderError())
      .mockResolvedValueOnce(
        makeStreamResponse('answer after size-detected compact'),
      );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'latest' },
      'prompt-id-size-detected',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Exactly one reactive, forced compaction (the pre-send cheap-gate is
    // skipped by the hard-tier NOOP branch while the breaker is latched).
    const forcedCalls = compressSpy.mock.calls.filter(
      (call) => call[1]?.force === true,
    );
    expect(forcedCalls).toHaveLength(1);
    expect(forcedCalls[0]![1].trigger).toBe('auto');

    // The oversized send was retried after the recovery.
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === StreamEventType.RETRY)).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === StreamEventType.CHUNK &&
          e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
            'answer after size-detected compact',
      ),
    ).toBe(true);
  });

  it('does not compress on an opaque 400 when the context fits the window', async () => {
    // Same opaque 400, but the prompt is comfortably UNDER the window, so the
    // size branch stays false and the error must surface unchanged. This differs
    // from the recovering case ONLY by lastPromptTokenCount (the prompt size).
    chat.setLastPromptTokenCount(1_000);

    const compressSpy = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 1_000,
          newTokenCount: 500,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });

    vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValueOnce(
      opaqueProviderError(),
    );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'latest' },
      'prompt-id-normal-size',
    );

    await expect(
      (async () => {
        for await (const _ of stream) {
          /* consume */
        }
      })(),
    ).rejects.toThrow('Error from inference-provider');

    // No reactive (forced) compaction happened, and the send was NOT retried.
    const forcedCalls = compressSpy.mock.calls.filter(
      (call) => call[1]?.force === true,
    );
    expect(forcedCalls).toHaveLength(0);
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(1);
  });
});
