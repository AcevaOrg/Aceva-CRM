import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { FILE_STORAGE } from '../storage/file-storage';
import { LocalFileStorage } from '../storage/local-file-storage';
import { JobRunner } from '../jobs/job-runner.service';
import { OrgModule } from '../org/org.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { JoiningService } from './joining.service';
import { OffboardingService } from './offboarding.service';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

/** Module 3: employee profiles, joining and leaving. */
@Module({
  imports: [OrgModule],
  controllers: [PeopleController, DocumentsController],
  providers: [
    PeopleService,
    JoiningService,
    DocumentsService,
    OffboardingService,
    JobRunner,
    // Private file storage. Today a private folder on this computer; AWS S3 or Cloudflare R2 plug in here later.
    { provide: FILE_STORAGE, inject: [ENV], useFactory: (env: Env) => new LocalFileStorage(env.FILE_STORAGE_ROOT) },
  ],
  exports: [PeopleService],
})
export class PeopleModule {}
