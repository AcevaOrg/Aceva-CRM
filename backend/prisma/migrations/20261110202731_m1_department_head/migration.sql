-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "head_employee_id" UUID;

-- CreateIndex
CREATE INDEX "departments_head_employee_id_idx" ON "departments"("head_employee_id");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_employee_id_fkey" FOREIGN KEY ("head_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
