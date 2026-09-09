import { Injectable } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * The OpenAPI document, held for the developer reference.
 *
 * `SwaggerModule.createDocument` needs the whole application, so it can only
 * run in `main.ts` after boot. Nothing else in the process needs the document
 * except the route that serves it, and that route lives inside Nest's guards —
 * unlike Swagger's own UI, which mounts on Express directly and is therefore
 * reachable without a token. So the document is built once, put here, and
 * served by a guarded controller; the UI stays a development convenience.
 */
@Injectable()
export class OpenApiDocumentService {
  private document: OpenAPIObject | null = null;

  set(document: OpenAPIObject): void {
    this.document = document;
  }

  get(): OpenAPIObject | null {
    return this.document;
  }
}
