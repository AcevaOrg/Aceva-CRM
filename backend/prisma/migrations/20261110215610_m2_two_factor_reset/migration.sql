-- AlterTable
ALTER TABLE "credentials" ADD COLUMN     "must_enroll_two_factor" BOOLEAN NOT NULL DEFAULT false;
