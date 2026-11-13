import { Global, Module } from '@nestjs/common';
import { JobRunner } from './job-runner.service';

/**
 * ONE job runner for the whole application. Every module registers its handlers on this single instance
 * (jobs.register(type, handler) in its constructor). A module must never provide JobRunner itself: a second
 * instance would run its own loop with a different handler list and fail jobs it does not know.
 */
@Global()
@Module({
  providers: [JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
