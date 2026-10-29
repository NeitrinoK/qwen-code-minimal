/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// This suite reuses client.test.ts's harness (same directory): a GeminiClient
// built over a mocked Turn + a hand-rolled chat mock, and a Config whose
// getters are individually controllable. We drive one sendMessageStream turn to
// conclusion and observe whether the AskUserQuestion menu gate issued a
// follow-up (re-prompt) sendMessageStream. The follow-up is observed by spying
// on client.sendMessageStream (which calls through), then inspecting the
// recursive call whose options carry `askQuestionGateState`.

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
  ASK_QUESTION_GATE_CAP,
  ASK_QUESTION_GATE_SKILL,
  ASK_QUESTION_REPROMPT_MESSAGE,
} from './askQuestionMenuGate.js';

// --- Mocks (mirrors client.test.ts) ---
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

const OPTIONS_QUESTION = [
  'Which approach do you prefer?',
  '1. Rewrite from scratch',
  '2. Patch the existing module',
  '3. Do nothing for now',
].join('\n');

const NON_OPTIONS_MESSAGE = 'All done. The change is complete.';

describe('client AskUserQuestion menu gate', () => {
  let mockContentGenerator: ContentGenerator;
  let mockConfig: Config;
  let client: GeminiClient;
  let getLastModelMessageText: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(createContentGenerator).mockRejectedValue(
      new Error('no auth in test env'),
    );
    setSimulate429(false);

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
      // AskUserQuestion menu gate surface (defaults enable the gate):
      getAskQuestionMenuEnforced: vi.fn().mockReturnValue(true),
      // Writing-plans gate surface. Inert (disabled) so the sibling gate never
      // fires in these AskUserQuestion tests.
      getWritingPlansEnforced: vi.fn().mockReturnValue(false),
      hasInvokedSkill: vi.fn().mockReturnValue(true),
      isInteractive: vi.fn().mockReturnValue(true),
      assertCanStartTurn: vi.fn().mockResolvedValue(undefined),
      getEffectiveInputModalities: vi.fn().mockReturnValue({}),
      getStaticSystemPrefix: vi.fn(() => undefined),
      setStaticSystemPrefix: vi.fn(),
      getAutoMemoryPrompt: vi.fn(() => ''),
      startActiveTodoWorkChain: vi.fn(),
      startAutomaticActiveTodoWorkChain: vi.fn(),
      endAutomaticActiveTodoWorkChain: vi.fn(),
      takeActiveTodoReminder: vi.fn(() => undefined),
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

    // Each turn's Turn.run yields a single content event and concludes with no
    // pending tool calls (MockTurn.pendingToolCalls = []).
    mockTurnRunFn.mockImplementation(async function* () {
      yield { type: GeminiEventType.Content, value: 'response' };
    });

    // Hand-rolled chat mock. getLastModelMessageText scripts the model's final
    // message per turn; the gate reads it via client.getLastModelMessageText().
    getLastModelMessageText = vi.fn().mockReturnValue(OPTIONS_QUESTION);
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
   * the re-ask instruction. Identifying by message text (not by the presence of
   * askQuestionGateState) avoids counting a driving call that seeds the
   * counter. Each such call also carries the bumped askQuestionGateState. */
  function repromptCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter((c: unknown[]) => {
      const parts = c[0] as Array<{ text?: string }>;
      return parts?.[0]?.text === ASK_QUESTION_REPROMPT_MESSAGE;
    });
  }

  async function drain(gen: AsyncGenerator<unknown>) {
    for await (const _ of gen) {
      /* drain */
    }
  }

  it('re-prompts once when brainstorming-active turn ends in a prose options question', async () => {
    // Model asks in prose first, then (after the re-prompt) complies with a
    // normal final message, so exactly one re-prompt is issued.
    getLastModelMessageText
      .mockReturnValueOnce(OPTIONS_QUESTION)
      .mockReturnValue(NON_OPTIONS_MESSAGE);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'help me decide' }],
        new AbortController().signal,
        'prompt-ask-1',
        { type: SendMessageType.UserQuery },
      ),
    );

    const reprompts = repromptCalls(sendSpy);
    expect(reprompts).toHaveLength(1);
    expect(reprompts[0][0]).toEqual([{ text: ASK_QUESTION_REPROMPT_MESSAGE }]);
    expect(
      (reprompts[0][3] as { askQuestionGateState: { iterationCount: number } })
        .askQuestionGateState.iterationCount,
    ).toBe(1);
    // And the re-prompt turn carries a Hook type.
    expect((reprompts[0][3] as { type: SendMessageType }).type).toBe(
      SendMessageType.Hook,
    );
  });

  it('does not re-prompt when brainstorming is inactive', async () => {
    vi.mocked(mockConfig.hasInvokedSkill).mockReturnValue(false);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'help me decide' }],
        new AbortController().signal,
        'prompt-ask-2',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
    expect(mockTurnRunFn).toHaveBeenCalledTimes(1);
  });

  it('does not re-prompt a non-options final message', async () => {
    getLastModelMessageText.mockReturnValue(NON_OPTIONS_MESSAGE);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'do the thing' }],
        new AbortController().signal,
        'prompt-ask-3',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
  });

  it('stops after the cap even if the model keeps asking in prose', async () => {
    // Constant options question; start one below the cap. Exactly one more
    // re-prompt (to the cap) is issued, then it stops.
    getLastModelMessageText.mockReturnValue(OPTIONS_QUESTION);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'still deciding' }],
        new AbortController().signal,
        'prompt-ask-4',
        {
          type: SendMessageType.Hook,
          askQuestionGateState: { iterationCount: ASK_QUESTION_GATE_CAP - 1 },
        },
      ),
    );

    const reprompts = repromptCalls(sendSpy);
    expect(reprompts).toHaveLength(1);
    expect(
      (reprompts[0][3] as { askQuestionGateState: { iterationCount: number } })
        .askQuestionGateState.iterationCount,
    ).toBe(ASK_QUESTION_GATE_CAP);
    // No re-prompt ever exceeds the cap.
    for (const c of reprompts) {
      expect(
        (c[3] as { askQuestionGateState: { iterationCount: number } })
          .askQuestionGateState.iterationCount,
      ).toBeLessThanOrEqual(ASK_QUESTION_GATE_CAP);
    }
  });

  it('re-prompts at most CAP times when driven from zero with a constant prose question', async () => {
    getLastModelMessageText.mockReturnValue(OPTIONS_QUESTION);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'decide please' }],
        new AbortController().signal,
        'prompt-ask-5',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(ASK_QUESTION_GATE_CAP);
  });

  it('does not fire when the setting is disabled', async () => {
    vi.mocked(mockConfig.getAskQuestionMenuEnforced).mockReturnValue(false);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'help me decide' }],
        new AbortController().signal,
        'prompt-ask-6',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
  });

  it('does not fire in a non-interactive session', async () => {
    vi.mocked(mockConfig.isInteractive).mockReturnValue(false);
    const sendSpy = vi.spyOn(client, 'sendMessageStream');

    await drain(
      client.sendMessageStream(
        [{ text: 'help me decide' }],
        new AbortController().signal,
        'prompt-ask-7',
        { type: SendMessageType.UserQuery },
      ),
    );

    expect(repromptCalls(sendSpy)).toHaveLength(0);
    // Sanity: the gate constant used by the client matches Task 1's export.
    expect(mockConfig.hasInvokedSkill).not.toHaveBeenCalledWith(
      'some-other-skill',
    );
    expect(ASK_QUESTION_GATE_SKILL).toBe('superpowers:brainstorming');
  });
});
