import type { GenerateContentConfig } from '@google/genai';
import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';

export type OpenAIRequestContextOverrides = {
  splitToolMedia?: boolean;
  toolResultContentFormat?: ContentGeneratorConfig['toolResultContentFormat'];
};

export interface OpenAICompatibleProvider {
  buildHeaders(): Record<string, string | undefined>;
  buildClient(): OpenAI;
  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
    reattachBlockCount?: number,
  ): OpenAI.Chat.ChatCompletionCreateParams;
  getDefaultGenerationConfig(): GenerateContentConfig;
  getResponseParsingOptions?(model?: string): OpenAIResponseParsingOptions;
  getRequestContextOverrides?(): OpenAIRequestContextOverrides;
}
