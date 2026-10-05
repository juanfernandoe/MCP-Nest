import { INestApplication, UsePipes, ValidationPipe } from '@nestjs/common';
import { Payload, RpcException } from '@nestjs/microservices';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';
import { McpController, McpStrategy, Prompt, Tool } from '@rekog/mcp-nest';
import { bootstrapMcpApp, createEraClient, ERAS } from './utils';

class AddressDto {
  @ApiProperty({ description: 'City name' })
  city!: string;
}

class CreateUserDto {
  @ApiProperty({ description: 'Display name', minLength: 3 })
  name!: string;

  @ApiProperty({ type: 'integer', minimum: 18 })
  age!: number;

  @ApiPropertyOptional({ enum: ['admin', 'member'] })
  role?: string;

  @ApiPropertyOptional()
  address?: AddressDto;
}

class UserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

class InviteDto {
  // Deliberately no `format: 'email'`: the advertised schema only says
  // "string", so the address rule is left to class-validator.
  @ApiProperty()
  @IsEmail()
  email!: string;
}

class ReviewDto {
  @ApiProperty({ description: 'The code to review' })
  code!: string;

  @ApiPropertyOptional({ description: 'What to focus on' })
  focus?: string;
}

@McpController()
class SwaggerSchemaController {
  @Tool({
    name: 'create-user',
    description: 'Creates a user, described by @nestjs/swagger DTOs',
    parameters: CreateUserDto,
    outputSchema: UserDto,
  })
  createUser(@Payload() dto: CreateUserDto) {
    return { id: 'user-1', name: dto.name };
  }

  @Tool({
    name: 'broken-output',
    description: 'Returns an object that does not match its DTO outputSchema',
    outputSchema: UserDto,
  })
  brokenOutput() {
    return { id: 1 };
  }

  @Tool({
    name: 'invite',
    description: 'One DTO for both the advertised schema and class-validator',
    parameters: InviteDto,
  })
  @UsePipes(
    new ValidationPipe({
      transform: true,
      exceptionFactory: (errors) =>
        new RpcException(
          'Validation failed: ' +
            errors
              .map((e) => Object.values(e.constraints ?? {}).join(', '))
              .join('; '),
        ),
    }),
  )
  invite(@Payload() dto: InviteDto) {
    return {
      content: [
        {
          type: 'text',
          text: `Invited ${dto.email}; instance=${dto instanceof InviteDto}`,
        },
      ],
    };
  }

  @Prompt({
    name: 'review',
    description: 'Review a piece of code',
    parameters: ReviewDto,
  })
  review(@Payload() { code, focus }: ReviewDto) {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review (${focus ?? 'everything'}): ${code}`,
          },
        },
      ],
    };
  }
}

describe.each(ERAS)(
  'E2E: @nestjs/swagger DTO classes as schemas (%s era)',
  (era) => {
    let app: INestApplication;
    let port: number;
    let strategy: McpStrategy;

    beforeAll(async () => {
      const ctx = await bootstrapMcpApp({
        name: 'swagger-schema-server',
        controllers: [SwaggerSchemaController],
      });
      app = ctx.app;
      port = ctx.port;
      strategy = ctx.strategy;
    });

    afterAll(async () => {
      await app.close();
    });

    it('advertises the DTOs as JSON Schema 2020-12 in tools/list', async () => {
      const client = await createEraClient(era, port);
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'create-user');
      expect(tool?.inputSchema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name', minLength: 3 },
          age: { type: 'integer', minimum: 18 },
          role: { type: 'string', enum: ['admin', 'member'] },
          address: { $ref: '#/$defs/AddressDto' },
        },
        required: ['name', 'age'],
        $defs: {
          AddressDto: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'City name' },
            },
            required: ['city'],
          },
        },
      });
      expect(tool?.outputSchema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      });
      await client.close();
    });

    it('calls the tool and returns the output DTO as structuredContent', async () => {
      const client = await createEraClient(era, port);
      const result = await client.callTool({
        name: 'create-user',
        arguments: { name: 'Alice', age: 30, address: { city: 'Lima' } },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ id: 'user-1', name: 'Alice' });
      await client.close();
    });

    it('rejects input that violates an @ApiProperty() constraint', async () => {
      const client = await createEraClient(era, port);
      const result = (await client.callTool({
        name: 'create-user',
        arguments: { name: 'Bob', age: 10 },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid parameters');
      expect(result.content[0].text).toContain('age');
      await client.close();
    });

    it('rejects input that violates a nested DTO', async () => {
      const client = await createEraClient(era, port);
      const result = (await client.callTool({
        name: 'create-user',
        arguments: { name: 'Bob', age: 30, address: {} },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("'city'");
      await client.close();
    });

    it('fails a result that does not match the output DTO', async () => {
      const client = await createEraClient(era, port);
      await expect(
        client.callTool({ name: 'broken-output', arguments: {} }),
      ).rejects.toThrow(/does not match outputSchema/);
      await client.close();
    });

    it('hands the validated payload on to a class-validator ValidationPipe', async () => {
      const client = await createEraClient(era, port);
      const ok = (await client.callTool({
        name: 'invite',
        arguments: { email: 'alice@example.com' },
      })) as { content: Array<{ text: string }> };
      expect(ok.content[0].text).toBe(
        'Invited alice@example.com; instance=true',
      );

      // A string, so the advertised schema is satisfied; @IsEmail() is not.
      const bad = (await client.callTool({
        name: 'invite',
        arguments: { email: 'not-an-email' },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain('Validation failed');
      await client.close();
    });

    it('lists prompt arguments from a DTO', async () => {
      const client = await createEraClient(era, port);
      const { prompts } = await client.listPrompts();
      expect(prompts.find((p) => p.name === 'review')).toEqual({
        name: 'review',
        description: 'Review a piece of code',
        arguments: [
          { name: 'code', description: 'The code to review', required: true },
          { name: 'focus', description: 'What to focus on', required: false },
        ],
      });

      const result: any = await client.getPrompt({
        name: 'review',
        arguments: { code: 'x = 1', focus: 'naming' },
      });
      expect(result.messages[0].content.text).toBe('Review (naming): x = 1');
      await client.close();
    });

    it('accepts a DTO on a dynamically registered tool', async () => {
      strategy.registerTool({
        name: 'dynamic-create-user',
        description: 'Registered at runtime with a DTO schema',
        parameters: CreateUserDto,
        handler: (args) => ({
          content: [{ type: 'text', text: `Created ${String(args.name)}` }],
        }),
      });
      const client = await createEraClient(era, port);
      try {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === 'dynamic-create-user');
        expect(tool?.inputSchema.required).toEqual(['name', 'age']);

        const bad = (await client.callTool({
          name: 'dynamic-create-user',
          arguments: { name: 'Al', age: 30 },
        })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(bad.isError).toBe(true);
        expect(bad.content[0].text).toContain('Invalid parameters');
      } finally {
        strategy.removeTool('dynamic-create-user');
        await client.close();
      }
    });
  },
);
