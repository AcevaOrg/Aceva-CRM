import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo } from '../access/decorators';
import { DocumentsService, MAX_DOCUMENT_BYTES, type UploadedFile as UploadedFileData } from './documents.service';

@ApiTags('employees')
@Controller('employees/:empId')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('documents')
  @Authenticated()
  @ApiOperation({ summary: 'Documents of an employee (the employee, HR, Director and above)' })
  list(@CurrentActor() actor: Actor, @Param('empId') empId: string, @ClientInfo() client: RequestInfo) {
    return this.documents.list(actor, empId, client);
  }

  @Post('documents')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES + 1, files: 1 } }))
  @ApiOperation({ summary: 'Upload a CV, contract, CNIC copy or certificate (PDF, PNG, JPEG or .docx, 10 MB). Stored privately.' })
  upload(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @UploadedFile() file: UploadedFileData | undefined,
    @Body() body: { type?: string; title?: string },
    @ClientInfo() client: RequestInfo,
  ) {
    return this.documents.upload(actor, empId, file, { type: body?.type, title: body?.title }, client);
  }

  @Get('documents/:documentId/download')
  @Authenticated()
  @ApiOperation({ summary: 'Download a document. Permission is checked every time, and every download is logged.' })
  async download(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @ClientInfo() client: RequestInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.documents.download(actor, empId, documentId, client);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.buffer);
  }

  @Delete('documents/:documentId')
  @Authenticated()
  @ApiOperation({ summary: 'Archive a document (kept, never deleted)' })
  archive(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Param('documentId', new ParseUUIDPipe()) documentId: string, @Body() body: { reason?: string } | undefined, @ClientInfo() client: RequestInfo) {
    return this.documents.archive(actor, empId, documentId, client, typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null);
  }

  @Post('photo')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 + 1, files: 1 } }))
  @ApiOperation({ summary: 'Set the profile photo (JPEG or PNG, 2 MB): the employee, or Director/HR' })
  setPhoto(@CurrentActor() actor: Actor, @Param('empId') empId: string, @UploadedFile() file: UploadedFileData | undefined, @ClientInfo() client: RequestInfo) {
    return this.documents.setPhoto(actor, empId, file, client);
  }

  @Get('photo')
  @Authenticated()
  @ApiOperation({ summary: 'The profile photo (basic information, visible to every logged-in employee)' })
  async photo(@Param('empId') empId: string, @Res({ passthrough: true }) res: Response) {
    const photo = await this.documents.photo(empId);
    res.set({ 'Content-Type': photo.mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' });
    return new StreamableFile(photo.buffer);
  }
}
