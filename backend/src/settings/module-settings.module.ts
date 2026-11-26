import { Global, Module } from '@nestjs/common';
import { ModuleSettingsController } from './module-settings.controller';
import { ModuleSettingsService } from './module-settings.service';

/** Module-owned settings (Cycle 3 shared foundation). Global, so every module can register its own settings. */
@Global()
@Module({
  controllers: [ModuleSettingsController],
  providers: [ModuleSettingsService],
  exports: [ModuleSettingsService],
})
export class ModuleSettingsModule {}
