import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessController } from './access.controller';
import { AccessGuard } from './access.guard';
import { AuditService } from './audit.service';
import { HierarchyCache, HierarchyService, PostgresHierarchyCache } from './hierarchy.service';
import { PermissionService } from './permission.service';
import { ScopeService } from './scope.service';

/**
 * M1 core. Global, so every later module can inject ScopeService, PermissionService,
 * AuditService and the hierarchy services without importing anything.
 */
@Global()
@Module({
  controllers: [AccessController],
  providers: [
    AuditService,
    PermissionService,
    ScopeService,
    HierarchyService,
    { provide: HierarchyCache, useClass: PostgresHierarchyCache },
    // Every route is protected by default.
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AuditService, PermissionService, ScopeService, HierarchyService, HierarchyCache],
})
export class AccessModule {}
