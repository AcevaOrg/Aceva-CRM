-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "csrf_token_hash" TEXT;

-- AlterTable
ALTER TABLE "totp_secrets" ADD COLUMN     "last_used_step" BIGINT;
