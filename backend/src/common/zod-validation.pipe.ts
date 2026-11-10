import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/**
 * Request validation uses the SAME Zod schemas as the frontend (packages/contracts).
 *
 * Declare a request class from a schema:
 *     export class LoginDto extends createZodDto(loginRequestSchema) {}
 * and use it as the type of a @Body() / @Query() / @Param() argument. The global pipe
 * below validates it and returns the parsed value (unknown fields are stripped).
 * Arguments that are not made with createZodDto are left untouched.
 */
export function createZodDto<T extends z.ZodType>(schema: T) {
  class ZodDto {
    static readonly schema = schema;
  }
  return ZodDto as unknown as { new (): z.infer<T>; readonly schema: T };
}

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as { schema?: z.ZodType } | undefined)?.schema;
    if (!schema || typeof schema.safeParse !== 'function') {
      return value;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
