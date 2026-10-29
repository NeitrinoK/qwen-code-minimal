/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// This suite reuses client.askQuestion.test.ts's harness (same directory): a
// GeminiClient built over a mocked Turn + a hand-rolled chat mock, and a Config
// whose getters are individually controllable. We drive one sendMessageStream
// turn to conclusion and observe whether the writing-plans gate issued a
// follow-up (re-prompt) sendMessageStream. The follow-up is observed by spying
// on client.sendMessageStream (which calls through), then filtering the
// recursive calls whose message text is WRITING_PLANS_REPROMPT_MESSAGE.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.TZ = 'UTC';

import type { GenerateContentResponse } from '@google/genai';
import { GeminiClient, SendMessageType } from './client.js';
import {
  AuthType,
  createContentGenerator,
  type ContentGenerator,
  type ContentGeneratorConfig,
} from './contentGenerator.js';
import { BaseLlmClient } from './baseLlmClient.js';
import type { GeminiChat } from './geminiChat.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { setSimulate429 } from '../utils/testUtils.js';
import { CompressionStatus, GeminiEventType } from './turn.js';
import {
  WRITING_PLANS_GATE_CAP,
  WRITING_PLANS_GATE_SKILL,
  BRAINSTORMING_SKILL,
  WRITING_PLANS_REPROMPT_MESSAGE,
} from './writingPlansGate.js';

// --- Mocks (mirrors client.askQuestion.test.ts) ---
const mockTurnRunFn = vi.fn();

vi.mock('./turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./turn.js')>();
  class MockTurn {
    pendingToolCalls = [];
    run = mockTurnRunFn;
    constructor() {}
  }
  return { ...actual, Turn: MockTurn };
});

vi.mock('../config/config.js');
vi.mock('./prompts');
vi.mock('../models/content-generator-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../models/content-generator-config.js')
    >();
  return {
    ...actual,
    buildAgentContentGeneratorConfig: vi
      .fn()
      .mockImplementation(actual.buildAgentContentGeneratorConfig),
  };
});
vi.mock('./contentGenerator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contentGenerator.js')>();
  return { ...actual, createContentGenerator: vi.fn() };
});
vi.mock('../utils/getFolderStructure', () => ({
  getFolderStructure: vi.fn().mockResolvedValue('Mock Folder Structure'),
}));
vi.mock('../utils/errorReporting', () => ({ reportError: vi.fn() }));
vi.mock('../utils/gitUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/gitUtils.js')>();
  return { ...actual, getRecentGitStatus: vi.fn().mockReturnValue(null) };
});
vi.mock('../utils/nextSpeakerChecker', () => ({
  checkNextSpeaker: vi.fn().mockResolvedValue(null),
}));
vi.mock('../tools/skill-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../tools/skill-utils.js')>();
  return { ...actual, collectAvailableSkillEntries: vi.fn() };
});
vi.mock('./environmentContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./environmentContext.js')>();
  return {
    ...actual,
    getEnvironmentContext: vi
      .fn()
      .mockResolvedValue([{ text: 'Mocked env context' }]),
    getDirectoryContextString: vi
      .fn()
      .mockResolvedValue('Mocked directory context'),
    getInitialChatHistory: vi.fn(async (_config, extraHistory) => [
      [
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nMocked env context\n</system-reminder>',
            },
          ],
        },
        ...(extraHistory ?? []),
      ],
      [],
    ]),
    buildAddedMcpToolsReminder: vi.fn(() => null),
    getStartupContextLength: vi.fn(() => 1),
    isSystemReminderContent: vi.fn(() => false),
  };
});
vi.mock('../utils/generateContentResponseUtilities', () => ({
  getResponseText: (result: GenerateContentResponse) =>
    result.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') ||
    undefined,
  getFunctionCalls: () => undefined,
}));
const mockUiTelemetryService = vi.hoisted(() => ({
  setLastPromptTokenCount: vi.fn(),
  getLastPromptTokenCount: vi.fn(),
  setLastCachedContentTokenCount: vi.fn(),
  reset: vi.fn(),
  resetSession: vi.fn(),
  addEvent: vi.fn(),
}));
vi.mock('../telemetry/tracer.js', () => ({
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE: 'API call aborted',
  API_CALL_FAILED_SPAN_STATUS_MESSAGE: 'API call failed',
}));
vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, uiTelemetryService: mockUiTelemetryService };
});
vi.mock('../telemetry/uiTelemetry.js', () => ({
  uiTelemetryService: mockUiTelemetryService,
}));
vi.mock('../telemetry/loggers.js', () => ({
  logChatCompression: vi.fn(),
  logNextSpeakerCheck: vi.fn(),
  logApiRequest: vi.fn(),
  logLoopDetected: vi.fn(),
  logLoopDetectionDisabled: vi.fn(),
}));
const { mockClientDebugLogger } = vi.hoisted(() => ({
  mockClientDebugLogger: {
    isEnabled: vi.fn().mockReturnValue(false),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (namespace: string) =>
      namespace === 'CLIENT'
        ? mockClientDebugLogger
        : actual.createDebugLogger(namespace),
  };
});
vi.mock(
  '../services/microcompaction/microcompact.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../services/microcompaction/microcompact.js')
      >();
    return {
      ...actual,
      microcompactHistory: vi.fn(actual.microcompactHistory),
    };
  },
);
vi.mock('../utils/retry.js', () => ({
  retryWithBackoff: vi.fn(async (fn) => await fn()),
  isUnattendedMode: vi.fn(() => false),
}));

// A substantive declarative "I'll implement" design turn with NO '?'. Multiple
// non-empty lines makes it substantive per looksLikeDeclarativeImplementationTurn.
const DECLARATIVE_MESSAGE = [
  "Great, the design is clear. I'll implement it now.",
  '- Add a new module for the parser.',
  '- Wire it into the main pipeline.',
  '- Update the CLI entry point to call it.',
].join('\n');

// A final message containing a '?' — the writing-plans gate must defer here.
const QUESTION_MESSAGE = [
  'Which approach do you prefer?',
  '1. Rewrite from scratch',
  '2. Patch the existing module',
].join('\n');

describe('client writing-plans gate', () => {
  let mockContentGenerator: ContentGenerator;
  let mockConfig: Config;
  let client: GeminiClient;
  let getLastModelMessageText: ReturnType<typeof vi.fn>;
  // Controllable set of "invoked" skills. Seeded per-test.
  let invokedSkills: Set<string>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(createContentGenerator).mockRejectedValue(
      new Error('no auth in test env'),
    );
    setSimulate429(false);

    invokedSkills = new Set<string>([BRAINSTORMING_SKILL]);

    mockContentGenerator = {
      generateContent: vi.fn().mockResolvedValue({
        candidates: [{ content: { parts: [{ text: '{"key":"value"}' }] } }],
      }),
      generateContentStream: vi.fn(),
      batchEmbedContents: vi.fn(),
      countTokens: vi.fn().mockResolvedValue({ totalTokens: 100 }),
    } as unknown as ContentGenerator;

    const mockToolRegistry = {
      warmAll: vi.fn().mockResolvedValue(undefined),
      ensureTool: vi.fn().mockResolvedValue(null),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
      clearReviewedDeclarations: vi.fn(),
      syncReviewedDeclarations: vi.fn(),
      getDeferredToolSummary: vi.fn().mockReturnValue([]),
      clearRevealedDeferredTools: vi.fn(),
      revealDeferredTool: vi.fn(),
      isDeferredToolRevealed: vi.fn().mockReturnValue(false),
      getTool: vi.fn().mockReturnValue(null),
      getMcpServerInstructions: vi.fn().mockReturnValue(new Map()),
    };
    const fileService = new FileDiscoveryService('/test/dir');
    const contentGeneratorConfig: ContentGeneratorConfig = {
      model: 'test-model',
      apiKey: 'test-key',
      authType: AuthType.USE_OPENAI,
    };
    mockConfig = {
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue(contentGeneratorConfig),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getModel: vi.fn().mockReturnValue('test-model'),
      getEmbeddingModel: vi.fn().mockReturnValue('test-embedding-model'),
      getApiKey: vi.fn().mockReturnValue('test-key'),
      getVertexAI: vi.fn().mockReturnValue(false),
      getUserAgent: vi.fn().mockReturnValue('test-agent'),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getAppendSystemPrompt: vi.fn().mockReturnValue(undefined),
      getFullContext: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getWorkingDir: vi.fn().mockReturnValue('/test/dir'),
      getFileService: vi.fn().mockReturnValue(fileService),
      getMaxSessionTurns: vi.fn().mockReturnValue(0),
      getClearContextOnIdle: vi.fn().mockReturnValue({
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 5,
      }),
      getSessionTokenLimit: vi.fn().mockReturnValue(32000),
      getNoBrowser: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(true),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getSdkMode: vi.fn().mockReturnValue(false),
      getDebugMode: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getGeminiClient: vi.fn(),
      getModelRouterService: vi.fn().mockReturnValue({
        route: vi.fn().mockResolvedValue({ model: 'default-routed-model' }),
      }),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getSkipNextSpeakerCheck: vi.fn().mockReturnValue(false),
      getUseModelRouter: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getCwd: vi.fn().mockReturnValue('/test/project/root'),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/temp'),
        getProjectDir: vi
          .fn()
          .mockReturnValue('/test/project/root/.gemini/projects/test-project'),
      },
      getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
      getBaseLlmClient: vi.fn(),
      getSkipLoopDetection: vi.fn().mockReturnValue(false),
      getChatRecordingService: vi.fn().mockReturnValue(undefined),
      getFileHistoryService: vi.fn().mockReturnValue({
        makeSnapshot: vi.fn().mockResolvedValue(undefined),
        getSnapshots: vi.fn().mockReturnValue([]),
        restoreFromSnapshots: vi.fn(),
        rewind: vi.fn(),
      }),
      getResumedSessionData: vi.fn().mockReturnValue(undefined),
      getArenaAgentClient: vi.fn().mockReturnValue(null),
      getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(false),
      isManagedMemoryAvailable: vi.fn().mockReturnValue(false),
      isTodoWriteEnabled: vi.fn().mockReturnValue(false),
      getCodeModeOnly: vi.fn().mockReturnValue(false),
      getModelRouteIdentity: vi.fn().mockReturnValue('test-route'),
      // The client touches memory-body bookkeeping on every history change.
      getMemoryManager: vi.fn().mockReturnValue({
        cancelMigrations: vi.fn(),
        getBodyPresentVersionsInHistory: vi.fn().mockReturnValue(new Map()),
        markAllMemoryBodiesEvictedFromHistory: vi.fn(),
        reconcileMemoryBodiesPresentInHistory: vi.fn(),
        resetExhaustedBodyRefsForCurrentTurn: vi.fn(),
        resetMemoryBodyStateForSession: vi.fn(),
        restoreMemoryBodiesPresentInHistory: vi.fn(),
        scoreSkillLaunches: vi.fn(),
      }),
      getAutoSkillEnabled: vi.fn().mockReturnValue(false),
      getAutoSkillConfirmEnabled: vi.fn().mockReturnValue(true),
      getModelsConfig: vi.fn().mockReturnValue({
        getResolvedModel: vi.fn().mockReturnValue(undefined),
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getStopHookBlockingCap: vi.fn().mockReturnValue(8),
      getArenaManager: vi.fn().mockReturnValue(null),
      getMessageBus: vi.fn().mockReturnValue(undefined),
      hasHooksForEvent: vi.fn().mockReturnValue(false),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getSkillManager: vi.fn().mockReturnValue(undefined),
      consumeInlineAnnouncedSkillKeys: vi
        .fn()
        .mockReturnValue(new Set<string>()),
      getDebugLogger: vi.fn().mockReturnValue({
        isEnabled: vi.fn().mockReturnValue(true),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
      getFileReadCache: vi.fn().mockReturnValue({ clear: vi.fn() }),
      // AskUserQuestion menu gate surface. Inert here (its declarative-message
      // path never matches a '?' menu), but kept so the sibling gate is quiet.
      getAskQuestionMenuEnforced: vi.fn().mockReturnValue(false),
      // Writing-plans gate surface (enabled; brainstorming seeded invoked,
      // writing-plans NOT invoked).
      getWritingPlansEnforced: vi.fn().mockReturnValue(true),
      hasInvokedSkill: vi.fn((name: string) => invokedSkills.has(name)),
      isInteractive: vi.fn().mockReturnValue(true),
      assertCanStartTurn: vi.fn().mockResolvedValue(undefined),
      getEffectiveInputModalities: vi.fn().mockReturnValue({}),
      getAutoMemoryPrompt: vi.fn(() => ''),
      startActiveTodoWorkChain: vi.fn(),
      startAutomaticActiveTodoWorkChain: vi.fn(),
      endAutomaticActiveTodoWorkChain: vi.fn(),
      takeActiveTodoReminder: vi.fn(() => undefined),
      getStaticSystemPrefix: vi.fn(() => undefined),
      setStaticSystemPrefix: vi.fn(),
    } as unknown as Config;

    const realBaseLlmClient = new BaseLlmClient(
      mockContentGenerator,
      mockConfig,
    );
    realBaseLlmClient.generateJson = vi
      .fn()
      .mockResolvedValue({ next_speaker: 'user', reasoning: 'test' });
    vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue(realBaseLlmClient);

    client = new GeminiClient(mockConfig);
    await client.initialize();
    vi.mocked(mockConfig.getGeminiClient).mockReturnValue(client);

    vi.spyOn(client, 'tryCompressChat').mockResolvedValue({
      originalTokenCount: 0,
      newTokenCount: 0,
      compressionStatus: CompressionStatus.NOOP,
    });

    mockTurnRunFn.mockImplementation(async function* () {
      yield { type: GeminiEventType.Content, value: 'response' };
    });

    getLastModelMessageText = vi.fn().mockReturnValue(DECLARATIVE_MESSAGE);
    client['chat'] = {
      addHistory: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      getHistoryShallow: vi.fn().mockReturnValue([]),
      getHistoryLength: vi.fn().mockReturnValue(0),
      getGenerationConfig: vi.fn().mockReturnValue({}),
      getLastPromptTokenCount: vi.fn().mockReturnValue(0),
      getLastModelMessageText,
      tryCompress: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: CompressionStatus.NOOP,
      }),
    } as unknown as GeminiChat;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Gate-issued re-prompt turns: the sendMessageStream calls whose message is
   * the writing-plans re-ask instruction. Identifying by message text (not by
   * the presence of writingPlansGateState) avoids counting a driving call that
   * seeds the counter. Each such call also carries the bumped state. */
  function repromptCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter((c: unknown[]) => {
      const parts = c[0] as Array<{ text?: string }>;
      return parts?.[0]?.text === WRITING_PLANS_REPROMPT_MESSAGE;
    });
  }

  async function drain(gen: AsyncGenerator<unknown>) {
    for await (const _ of gen) {
      /* drain */
    }
  }

  it('re-prompts once on a substantive declarative brainstorming turn with no plan', async () => {
    // First turn concludes declaratively; after the re-prompt, the model
    // complies with a message that no longer trips the gate (contains '?'), so
    // exactly one re-prompt is issued.
    getLastModelMessageText
      .mockReturnValueOnce(DECLARATIVE_MESSAGE)
      .mockReturnValue(QUESTION_MESSAGE);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-1',
        { type: SendMessageType.UserQuery },
      ),
    );

    const reprompts = repromptCalls(sendSpy);
    expect(reprompts).toHaveLength(1);
    expect(reprompts[0][0]).toEqual([{ text: WRITING_PLANS_REPROMPT_MESSAGE }]);
    expect(
      (
        reprompts[0][3] as {
          writingPlansGateState: { iterationCount: number };
        }
      ).writingPlansGateState.iterationCount,
    ).toBe(1);
    // And the re-prompt turn carries a Hook type.
    expect((reprompts[0][3] as { type: SendMessageType }).type).toBe(
      SendMessageType.Hook,
    );
  });

  it('does not re-prompt once writing-plans has been invoked', async () => {
    invokedSkills.add(WRITING_PLANS_GATE_SKILL);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-2',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
    expect(mockTurnRunFn).toHaveBeenCalledTimes(1);
  });

  it('does not re-prompt when brainstorming was never invoked', async () => {
    invokedSkills.delete(BRAINSTORMING_SKILL);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-3',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
  });

  it('does not re-prompt a question (has ?) — AskUserQuestion gate territory', async () => {
    getLastModelMessageText.mockReturnValue(QUESTION_MESSAGE);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-4',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
  });

  it('stops after the cap (2)', async () => {
    // Constant declarative message drives the gate from zero. It should
    // re-prompt exactly WRITING_PLANS_GATE_CAP times, then stop.
    getLastModelMessageText.mockReturnValue(DECLARATIVE_MESSAGE);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-5',
        { type: SendMessageType.UserQuery },
      ),
    );

    const reprompts = repromptCalls(sendSpy);
    expect(reprompts).toHaveLength(WRITING_PLANS_GATE_CAP);
    // No re-prompt ever exceeds the cap.
    for (const c of reprompts) {
      expect(
        (c[3] as { writingPlansGateState: { iterationCount: number } })
          .writingPlansGateState.iterationCount,
      ).toBeLessThanOrEqual(WRITING_PLANS_GATE_CAP);
    }
  });

  it('does not re-prompt when the setting is disabled', async () => {
    vi.mocked(mockConfig.getWritingPlansEnforced).mockReturnValue(false);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'build the parser' }],
        new AbortController().signal,
        'prompt-wp-6',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
    // Sanity: the gate constants used by the client match Task 1's exports.
    expect(WRITING_PLANS_GATE_SKILL).toBe('superpowers:writing-plans');
    expect(BRAINSTORMING_SKILL).toBe('superpowers:brainstorming');
  });
});
