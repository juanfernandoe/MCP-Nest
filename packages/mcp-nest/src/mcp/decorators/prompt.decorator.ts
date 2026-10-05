import { applyDecorators, SetMetadata, type Type } from '@nestjs/common';
import { MCP_PROMPT_METADATA_KEY } from './constants';
import { ZodObject, ZodType } from 'zod';
import { mcpMessagePattern } from './mcp-message-pattern';
import type {
  GetPromptResult,
  PromptMessage,
} from '@modelcontextprotocol/server';

export type { GetPromptResult, PromptMessage };

/**
 * Return type for an `@Prompt()` handler (return it directly or wrapped in a
 * `Promise`).
 *
 * Annotate your handler with this to get compile-time validation of the shape
 * the MCP SDK enforces at runtime — most usefully, message `role` is
 * `'user' | 'assistant'`
 * runtime failure:
 *
 * ```typescript
 * getGuide(): PromptResult {
 *   return {
 *     description: '...',
 *     messages: [{ role: 'assistant', content: { type: 'text', text: '...' } }],
 *   };
 * }
 * ```
 */
export type PromptResult = GetPromptResult;

export type PromptArgsRawShape = {
  [k: string]: ZodType;
};

/**
 * Schema accepted by a `@Prompt`'s `parameters`: a Zod object, or an
 * `@nestjs/swagger` DTO class whose `@ApiProperty()` metadata names and
 * describes the arguments (needs the optional peer dependency
 * `@nestjs/swagger` >=11.3.0).
 */
export type PromptArgsSchema = ZodObject<PromptArgsRawShape> | Type<unknown>;

export interface PromptMetadata {
  name: string;
  description: string;
  parameters?: PromptArgsSchema;
}

export interface PromptOptions {
  name?: string;
  description: string;
  parameters?: PromptArgsSchema;
}

export const Prompt = (options: PromptOptions) => {
  return applyDecorators(
    SetMetadata(MCP_PROMPT_METADATA_KEY, options),
    mcpMessagePattern('prompt', options.name),
  );
};
