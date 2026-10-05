import { describe, it, expect } from 'bun:test';
import {
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  PartialType,
} from '@nestjs/swagger';
import { swaggerDtoToJsonSchema } from './swagger-schema';
import { resolveToolSchema } from './tool-schema';

enum Role {
  Admin = 'admin',
  Member = 'member',
}

class AddressDto {
  @ApiProperty({ description: 'Street and number' })
  street!: string;

  @ApiPropertyOptional({ nullable: true })
  zip?: string | null;
}

class CreateUserDto {
  @ApiProperty({ description: 'Display name', minLength: 3, example: 'Alice' })
  name!: string;

  @ApiProperty({ type: 'integer', minimum: 18 })
  age!: number;

  @ApiPropertyOptional({ enum: Role, enumName: 'Role', default: Role.Member })
  role?: Role;

  @ApiProperty({ type: [String] })
  tags!: string[];

  @ApiProperty()
  address!: AddressDto;

  @ApiPropertyOptional({ type: [AddressDto] })
  previousAddresses?: AddressDto[];

  @ApiPropertyOptional()
  createdAt?: Date;
}

const validUser = {
  name: 'Alice',
  age: 30,
  tags: ['a'],
  address: { street: 'Main St 1' },
};

describe('swaggerDtoToJsonSchema', () => {
  it('projects a DTO to a self-contained JSON Schema 2020-12 document', () => {
    expect(swaggerDtoToJsonSchema(CreateUserDto)).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Display name',
          minLength: 3,
          examples: ['Alice'],
        },
        age: { type: 'integer', minimum: 18 },
        role: { default: 'member', allOf: [{ $ref: '#/$defs/Role' }] },
        tags: { type: 'array', items: { type: 'string' } },
        address: { $ref: '#/$defs/AddressDto' },
        previousAddresses: {
          type: 'array',
          items: { $ref: '#/$defs/AddressDto' },
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
      required: ['name', 'age', 'tags', 'address'],
      $defs: {
        Role: { type: 'string', enum: ['admin', 'member'] },
        AddressDto: {
          type: 'object',
          properties: {
            street: { type: 'string', description: 'Street and number' },
            zip: { type: ['string', 'null'] },
          },
          required: ['street'],
        },
      },
    });
  });

  // `fromJsonSchema` compiles one validator per schema object, so a fresh
  // object per request would recompile (and retain) a validator every time.
  it('returns the same schema object for the same class', () => {
    expect(swaggerDtoToJsonSchema(CreateUserDto)).toBe(
      swaggerDtoToJsonSchema(CreateUserDto),
    );
  });

  it('leaves nothing undefined behind for a client to trip over', () => {
    // generateSchema() emits `description: undefined` on a named enum.
    const role = (swaggerDtoToJsonSchema(CreateUserDto).$defs as any).Role;
    expect(Object.keys(role)).toEqual(['type', 'enum']);
  });

  it('follows the mapped types', () => {
    class UpdateUserDto extends PartialType(CreateUserDto) {}
    const schema = swaggerDtoToJsonSchema(UpdateUserDto);
    expect(Object.keys(schema.properties as object)).toContain('name');
    expect(schema.required).toBeUndefined();
  });

  it('reads the metadata the @nestjs/swagger CLI plugin generates', () => {
    class PluginDto {
      name!: string;
      nickname?: string;

      // What the plugin adds to a class with no @ApiProperty() of its own.
      static _OPENAPI_METADATA_FACTORY() {
        return {
          name: { required: true, type: () => String },
          nickname: { required: false, type: () => String },
        };
      }
    }
    expect(swaggerDtoToJsonSchema(PluginDto)).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' }, nickname: { type: 'string' } },
      required: ['name'],
    });
  });

  it('finds a class renamed with @ApiSchema({ name })', () => {
    @ApiSchema({ name: 'Renamed', description: 'A renamed DTO' })
    class OriginalDto {
      @ApiProperty()
      id!: string;
    }
    expect(swaggerDtoToJsonSchema(OriginalDto)).toMatchObject({
      type: 'object',
      description: 'A renamed DTO',
      properties: { id: { type: 'string' } },
    });
  });

  it('points a self-reference at the document root', async () => {
    class TreeDto {
      @ApiProperty()
      label!: string;

      @ApiProperty({ type: () => [TreeDto] })
      children!: TreeDto[];
    }
    const schema = swaggerDtoToJsonSchema(TreeDto);
    expect((schema.properties as any).children.items).toEqual({ $ref: '#' });
    expect(schema.$defs).toBeUndefined();

    const resolved = resolveToolSchema(TreeDto);
    const ok = await resolved.validate({
      label: 'root',
      children: [{ label: 'leaf', children: [] }],
    });
    expect(ok.success).toBe(true);
    const bad = await resolved.validate({
      label: 'root',
      children: [{ label: 1, children: [] }],
    });
    expect(bad.success).toBe(false);
  });

  describe('OpenAPI 3.0 keywords that 2020-12 spells differently', () => {
    class LegacyKeywordsDto {
      @ApiProperty({ nullable: true })
      note!: string | null;

      @ApiProperty({ enum: Role, nullable: true })
      role!: Role | null;

      // A `$ref` rejects null on its own, so null has to be an alternative.
      @ApiProperty({
        type: () => AddressDto,
        nullable: true,
        description: 'Billing address',
      })
      billing!: AddressDto | null;

      @ApiProperty({ minimum: 0, exclusiveMinimum: true, maximum: 10 })
      score!: number;

      @ApiProperty({
        type: 'object',
        additionalProperties: { type: 'string', nullable: true },
        // Data, not a schema: must not be rewritten.
        default: { nullable: true },
      })
      labels!: Record<string, string | null>;

      @ApiProperty({ examples: { low: { value: 1 }, high: { value: 9 } } })
      level!: number;
    }
    const properties = swaggerDtoToJsonSchema(LegacyKeywordsDto)
      .properties as Record<string, unknown>;

    it('turns nullable into a null type', () => {
      expect(properties.note).toEqual({ type: ['string', 'null'] });
    });

    it('adds null to a nullable enum', () => {
      expect(properties.role).toEqual({
        type: ['string', 'null'],
        enum: ['admin', 'member', null],
      });
    });

    it('makes null an alternative to a nullable $ref, annotations outside', () => {
      expect(properties.billing).toEqual({
        description: 'Billing address',
        anyOf: [
          { type: 'object', allOf: [{ $ref: '#/$defs/AddressDto' }] },
          { type: 'null' },
        ],
      });
    });

    it('turns a boolean exclusive bound into the bound itself', () => {
      expect(properties.score).toEqual({
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 10,
      });
    });

    it('converts nested schemas but leaves data alone', () => {
      expect(properties.labels).toEqual({
        type: 'object',
        additionalProperties: { type: ['string', 'null'] },
        default: { nullable: true },
      });
    });

    it('turns an examples map into an examples array', () => {
      expect(properties.level).toEqual({ type: 'number', examples: [1, 9] });
    });

    it('validates accordingly', async () => {
      const resolved = resolveToolSchema(LegacyKeywordsDto);
      const value = {
        note: null,
        role: null,
        billing: null,
        score: 5,
        labels: { a: null },
        level: 1,
      };
      expect((await resolved.validate(value)).success).toBe(true);
      // Exclusive: the bound itself is out.
      const atBound = await resolved.validate({ ...value, score: 0 });
      expect(atBound.success).toBe(false);
    });
  });

  it('rejects a class that documents no properties', () => {
    class UndecoratedDto {
      name!: string;
    }
    expect(() => swaggerDtoToJsonSchema(UndecoratedDto)).toThrow(
      /"UndecoratedDto"[\s\S]*@ApiProperty\(\)/,
    );
  });

  it('rejects a function that is not a class', () => {
    const notAClass = () => 1;
    expect(() => swaggerDtoToJsonSchema(notAClass as any)).toThrow(
      /"notAClass"[\s\S]*not a class/,
    );
  });
});

describe('resolveToolSchema with an @nestjs/swagger DTO class', () => {
  it('advertises the converted JSON Schema', () => {
    expect(resolveToolSchema(CreateUserDto).toJsonSchema('input')).toBe(
      swaggerDtoToJsonSchema(CreateUserDto),
    );
  });

  it('accepts valid input', async () => {
    const result = await resolveToolSchema(CreateUserDto).validate(validUser);
    expect(result).toEqual({ success: true, data: validUser });
  });

  it('enforces the constraints declared in @ApiProperty()', async () => {
    const result = await resolveToolSchema(CreateUserDto).validate({
      ...validUser,
      age: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain('age');
    }
  });

  it('validates nested DTOs and named enums through $defs', async () => {
    const resolved = resolveToolSchema(CreateUserDto);
    const badNested = await resolved.validate({ ...validUser, address: {} });
    expect(badNested.success).toBe(false);
    const badEnum = await resolved.validate({ ...validUser, role: 'root' });
    expect(badEnum.success).toBe(false);
  });

  it('reports every missing required property', async () => {
    const result = await resolveToolSchema(CreateUserDto).validate({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toContain("'name'");
      expect(result.message).toContain("'address'");
    }
  });
});
