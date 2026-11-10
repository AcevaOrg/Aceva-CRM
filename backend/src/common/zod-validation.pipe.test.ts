import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createZodDto, ZodValidationPipe } from './zod-validation.pipe';

class ExampleDto extends createZodDto(z.object({ name: z.string().min(2) })) {}

const pipe = new ZodValidationPipe();
const meta = { type: 'body' as const, metatype: ExampleDto };

describe('ZodValidationPipe', () => {
  it('returns parsed data and strips unknown fields', () => {
    expect(pipe.transform({ name: 'Ali', extra: 1 }, meta)).toEqual({ name: 'Ali' });
  });

  it('rejects invalid data with a 400 listing the problems', () => {
    expect(() => pipe.transform({ name: 'A' }, meta)).toThrow(BadRequestException);
    try {
      pipe.transform({}, meta);
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as { issues: Array<{ path: string }> };
      expect(response.issues[0].path).toBe('name');
    }
  });

  it('leaves arguments that are not Zod DTOs untouched', () => {
    expect(pipe.transform('abc', { type: 'param', metatype: String })).toBe('abc');
  });
});
