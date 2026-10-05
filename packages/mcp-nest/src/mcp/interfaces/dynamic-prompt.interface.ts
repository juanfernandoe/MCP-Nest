import type { McpContext } from '../transport/mcp-context';
import type { PromptArgsSchema } from '../decorators/prompt.decorator';

export type DynamicPromptHandler = (
  args: Record<string, string> | undefined,
  context: McpContext,
  request: any,
) => any;

export interface DynamicPromptDefinition {
  /** Unique name for the prompt */
  name: string;
  /** Description shown to the LLM */
  description: string;
  /** Zod object or `@nestjs/swagger` DTO class describing the prompt arguments */
  parameters?: PromptArgsSchema;
  /** Handler function that returns the prompt messages */
  handler: DynamicPromptHandler;
}
