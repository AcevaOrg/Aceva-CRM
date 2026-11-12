-- CreateEnum
CREATE TYPE "hire_request_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "hire_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "hire_request_status" NOT NULL DEFAULT 'pending',
    "name" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department_code" TEXT NOT NULL,
    "office_code" TEXT NOT NULL,
    "official_email" TEXT NOT NULL,
    "joining_date" DATE NOT NULL,
    "employment_type" "employment_type" NOT NULL,
    "weekly_capacity_hours" INTEGER,
    "proposed_level" INTEGER NOT NULL,
    "proposed_reports_to" TEXT NOT NULL,
    "sensitive_encrypted" TEXT,
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "employee_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hire_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hire_requests_employee_id_key" ON "hire_requests"("employee_id");

-- CreateIndex
CREATE INDEX "hire_requests_status_requested_at_idx" ON "hire_requests"("status", "requested_at");

-- AddForeignKey
ALTER TABLE "hire_requests" ADD CONSTRAINT "hire_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hire_requests" ADD CONSTRAINT "hire_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hire_requests" ADD CONSTRAINT "hire_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
