import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { JoiningService } from './joining.service';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

/** Module 3: employee profiles, joining and leaving. */
@Module({
  imports: [OrgModule],
  controllers: [PeopleController],
  providers: [PeopleService, JoiningService],
  exports: [PeopleService],
})
export class PeopleModule {}
