import { McpController, Tool } from '@rekog/mcp-nest';
import { Payload } from '@nestjs/microservices';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class CreateTaskDto {
  @ApiProperty({ description: 'What needs doing', minLength: 3 })
  title: string;

  @ApiPropertyOptional({ enum: ['low', 'high'] })
  priority?: string;
}

class TaskDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: ['low', 'high'] })
  priority: string;
}

@McpController()
export class SwaggerTool {
  // Parameters AND outputSchema are @nestjs/swagger DTO classes, no Zod
  // involved: the @ApiProperty() metadata becomes the JSON Schema advertised in
  // tools/list, and the same schema validates tools/call server-side.
  @Tool({
    name: 'swagger-create-task',
    description: 'Creates a task; input and output are @nestjs/swagger DTOs.',
    parameters: CreateTaskDto,
    outputSchema: TaskDto,
  })
  async createTask(@Payload() { title, priority }: CreateTaskDto) {
    return { id: 'task-1', title, priority: priority ?? 'low' };
  }
}
