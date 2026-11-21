import { Global, Module } from '@nestjs/common';
import { RealtimeBus } from './realtime-bus.service';
import { RedisService } from './redis.service';

@Global()
@Module({ providers: [RedisService, RealtimeBus], exports: [RedisService, RealtimeBus] })
export class RedisModule {}
