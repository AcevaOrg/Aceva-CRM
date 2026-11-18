import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/** Company settings by section (plan section 17). Global: any module reads its section through SettingsService. */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
