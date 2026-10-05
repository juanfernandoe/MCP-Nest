import type { Type } from '@nestjs/common';

type JsonObject = Record<string, unknown>;

/** The slice of `@nestjs/swagger`'s public API this module relies on. */
interface SwaggerApi {
  generateSchema(target: Type<unknown>): {
    schemas: Record<string, JsonObject>;
  };
  getSchemaPath(model: Type<unknown>): string;
}

let swaggerApi: SwaggerApi | undefined;

/**
 * `@nestjs/swagger` is an optional peer dependency, so it is required on first
 * use rather than imported: core has to load without it for everyone who
 * describes their tools with Zod or another validator.
 */
function loadSwagger(): SwaggerApi {
  if (swaggerApi) return swaggerApi;
  let loaded: Partial<SwaggerApi>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('@nestjs/swagger') as Partial<SwaggerApi>;
  } catch (error) {
    throw new Error(
      `A class was passed as an MCP schema, which is read as an @nestjs/swagger ` +
        `DTO, but the optional peer dependency "@nestjs/swagger" could not be ` +
        `loaded (${(error as Error).message}). Install @nestjs/swagger@>=11.3.0, ` +
        `or pass a Zod schema, a Standard Schema validator or a raw JSON Schema ` +
        `object instead.`,
    );
  }
  if (
    typeof loaded.generateSchema !== 'function' ||
    typeof loaded.getSchemaPath !== 'function'
  ) {
    throw new Error(
      `Passing a class as an MCP schema needs @nestjs/swagger@>=11.3.0, the ` +
        `first release to export generateSchema(); the installed version is older.`,
    );
  }
  return (swaggerApi = loaded as SwaggerApi);
}

// -----------------------------------------------------------------------------
// OpenAPI 3.0 Schema Object → JSON Schema 2020-12
// -----------------------------------------------------------------------------

/**
 * `@nestjs/swagger` emits OpenAPI 3.0 Schema Objects, whose dialect predates
 * JSON Schema 2020-12, the one MCP tool schemas must be in (see
 * `JSON_SCHEMA_TARGET` in `tool-schema.ts`). The two disagree on the keywords
 * handled in `convertSchema`; everything else carries over unchanged.
 */
const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Where `@nestjs/swagger` points the `$ref` to a nested DTO or a named enum. */
const OPENAPI_SCHEMA_REF_PREFIX = '#/components/schemas/';

// Every place an OpenAPI 3.0 Schema Object can hold another schema. Anything
// outside these (`default`, `enum`, `example`, …) is data and is not walked, so
// a default value that happens to have a `nullable` key is left alone.
const SUBSCHEMA_KEYWORDS = new Set(['items', 'not', 'additionalProperties']);
const SUBSCHEMA_LIST_KEYWORDS = new Set(['allOf', 'oneOf', 'anyOf']);
const SUBSCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties']);

const EXCLUSIVE_BOUNDS = [
  ['minimum', 'exclusiveMinimum'],
  ['maximum', 'exclusiveMaximum'],
] as const;

/** Keywords that describe a value rather than constrain it. */
const ANNOTATION_KEYWORDS = [
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `example` (one value) and the map form of `examples` (OpenAPI Example
 * Objects, whose payload is `value`) both become 2020-12's `examples` array.
 */
function collectExamples(schema: JsonObject): unknown[] {
  const examples: unknown[] = 'example' in schema ? [schema.example] : [];
  if (Array.isArray(schema.examples)) {
    examples.push(...(schema.examples as unknown[]));
  } else if (isObject(schema.examples)) {
    for (const example of Object.values(schema.examples)) {
      if (isObject(example) && 'value' in example) examples.push(example.value);
    }
  }
  return examples;
}

/** Rewrite a schema that carried `nullable: true` so that it accepts `null`. */
function allowNull(schema: JsonObject): JsonObject {
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
    schema.enum = [...(schema.enum as unknown[]), null];
  }
  const composed = ['$ref', 'allOf', 'oneOf', 'anyOf'].some(
    (keyword) => keyword in schema,
  );
  if (!composed) {
    // Without a `type` the schema accepts null already.
    if (typeof schema.type === 'string') schema.type = [schema.type, 'null'];
    return schema;
  }
  // A `$ref` or combinator rejects null on its own, so widening `type` would
  // not let it through; null has to be an alternative to the whole schema. The
  // annotations stay on the outside, where a client looks for them.
  const nullable: JsonObject = {};
  for (const keyword of ANNOTATION_KEYWORDS) {
    if (keyword in schema) {
      nullable[keyword] = schema[keyword];
      delete schema[keyword];
    }
  }
  nullable.anyOf = [schema, { type: 'null' }];
  return nullable;
}

function convertSchema(node: unknown, rootName: string): unknown {
  // `additionalProperties` may be a boolean rather than a schema.
  if (!isObject(node)) return node;
  const convert = (child: unknown) => convertSchema(child, rootName);

  const schema: JsonObject = {};
  for (const [keyword, value] of Object.entries(node)) {
    // generateSchema() leaves explicit `undefined`s behind (`description`, …).
    if (value === undefined) continue;
    if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      schema[keyword] = convert(value);
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
      schema[keyword] = value.map(convert);
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isObject(value)) {
      schema[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, convert(child)]),
      );
    } else {
      schema[keyword] = value;
    }
  }

  // The other DTOs move from the OpenAPI document's `components` to this
  // schema's own `$defs`; the DTO being converted is the document root.
  if (
    typeof schema.$ref === 'string' &&
    schema.$ref.startsWith(OPENAPI_SCHEMA_REF_PREFIX)
  ) {
    const name = schema.$ref.slice(OPENAPI_SCHEMA_REF_PREFIX.length);
    schema.$ref = name === rootName ? '#' : `#/$defs/${name}`;
  }

  // OpenAPI 3.0: a boolean modifying `minimum`/`maximum`. 2020-12: the bound.
  for (const [bound, exclusive] of EXCLUSIVE_BOUNDS) {
    if (typeof schema[exclusive] !== 'boolean') continue;
    if (schema[exclusive] && typeof schema[bound] === 'number') {
      schema[exclusive] = schema[bound];
      delete schema[bound];
    } else {
      delete schema[exclusive];
    }
  }

  const examples = collectExamples(schema);
  delete schema.example;
  delete schema.examples;
  if (examples.length > 0) schema.examples = examples;

  const nullable = schema.nullable === true;
  delete schema.nullable;
  return nullable ? allowNull(schema) : schema;
}

// -----------------------------------------------------------------------------
// DTO class → JSON Schema
// -----------------------------------------------------------------------------

/**
 * One JSON Schema object per DTO class, for good: `fromJsonSchema` compiles a
 * validator per schema *object*, so handing it a fresh conversion on every
 * request would recompile, and retain, a validator each time.
 */
const jsonSchemas = new WeakMap<Type<unknown>, JsonObject>();

/**
 * Project an `@nestjs/swagger` DTO class to a self-contained JSON Schema
 * 2020-12 document: the class itself at the root, the DTOs and named enums it
 * references under `$defs`.
 *
 * The properties come from `@nestjs/swagger` itself, so anything it documents
 * is picked up: `@ApiProperty()`, the mapped types (`PartialType`, `PickType`,
 * …) and the metadata its CLI plugin generates.
 */
export function swaggerDtoToJsonSchema(dto: Type<unknown>): JsonObject {
  const cached = jsonSchemas.get(dto);
  if (cached) return cached;

  const swagger = loadSwagger();
  const label = dto.name ? `"${dto.name}"` : 'An anonymous function';
  const { schemas } = swagger.generateSchema(dto);
  // generateSchema() also returns the DTO's own schema, but looks it up under
  // the class name and so misses a class renamed with @ApiSchema({ name }).
  const rootName = swagger
    .getSchemaPath(dto)
    .slice(OPENAPI_SCHEMA_REF_PREFIX.length);
  const { [rootName]: root, ...referenced } = schemas;
  if (!root) {
    throw new Error(
      `${label} was passed as an MCP schema but is not a class. Expected a Zod ` +
        `schema, a Standard Schema validator (with ~standard), an ` +
        `@nestjs/swagger DTO class, or a raw JSON Schema object.`,
    );
  }
  if (!isObject(root.properties) || Object.keys(root.properties).length === 0) {
    // An undecorated class would otherwise be advertised as taking no
    // arguments at all, which looks like a working tool and is not one.
    throw new Error(
      `${label} was passed as an MCP schema but documents no properties. ` +
        `Decorate each property with @ApiProperty() from @nestjs/swagger, or ` +
        `enable the @nestjs/swagger CLI plugin (it is not applied by test ` +
        `runners or ts-node unless configured there too). For a tool that ` +
        `takes no arguments, omit 'parameters' instead.`,
    );
  }

  const $defs = Object.fromEntries(
    Object.entries(referenced).map(([name, schema]) => [
      name,
      convertSchema(schema, rootName),
    ]),
  );
  const jsonSchema: JsonObject = {
    $schema: JSON_SCHEMA_DIALECT,
    ...(convertSchema(root, rootName) as JsonObject),
    ...(Object.keys($defs).length > 0 ? { $defs } : {}),
  };
  jsonSchemas.set(dto, jsonSchema);
  return jsonSchema;
}
