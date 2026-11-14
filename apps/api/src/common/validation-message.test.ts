import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validationMessage } from './domain-exception.filter';

describe('a refused request body says what was wrong', () => {
  it('names the field and the schema’s own words, never the value', () => {
    const result = z
      .object({ phone: z.string().regex(/^\+\d+$/, 'A phone number in international form') })
      .safeParse({ phone: '0912 secret' });
    expect(result.success).toBe(false);
    const message = validationMessage(new ZodValidationException(result.error));
    expect(message).toBe('Validation failed: phone: A phone number in international form');
    expect(message).not.toContain('secret');
  });

  it('leaves every other exception’s message alone', () => {
    expect(validationMessage(new NotFoundException('No such account'))).toBeNull();
    expect(validationMessage(new BadRequestException('Bad'))).toBeNull();
  });
});
