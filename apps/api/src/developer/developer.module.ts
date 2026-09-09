import { Global, Module } from '@nestjs/common';
import { DeveloperController } from './developer.controller';
import { OpenApiDocumentService } from './openapi-document.service';

/** Global so `main.ts` can hand the document in with `app.get(...)` after boot. */
@Global()
@Module({
  controllers: [DeveloperController],
  providers: [OpenApiDocumentService],
  exports: [OpenApiDocumentService],
})
export class DeveloperModule {}
