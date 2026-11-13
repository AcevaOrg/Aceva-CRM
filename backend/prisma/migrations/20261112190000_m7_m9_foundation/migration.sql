-- Cycle 3 shared foundation: Module 7 (attendance and leave), Module 8 (payroll), Module 9 (finance ledger).
-- Additive only: creates new types, tables, sequences, constraints and triggers. The only change to existing data is
-- the permission alignment at the end (see the comment there). Schema owner: Track A.

-- Hand-written: number sequences (LV-2026-0001, JE-2026-0001, INV-2026-0001, BILL-2026-0001). A sequence never hands out
-- the same number twice; numbers are not given back after a rollback (gaps are fine; reuse is not).
CREATE SEQUENCE "leave_request_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;
CREATE SEQUENCE "journal_entry_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;
CREATE SEQUENCE "invoice_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;
CREATE SEQUENCE "bill_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;
-- CreateEnum
CREATE TYPE "leave_request_status" AS ENUM ('pending_manager', 'pending_director', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "correction_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "payroll_stage" AS ENUM ('draft', 'calculated', 'prepared', 'reviewed', 'approved');

-- CreateEnum
CREATE TYPE "payroll_item_kind" AS ENUM ('bonus', 'deduction');

-- CreateEnum
CREATE TYPE "payroll_item_source" AS ENUM ('manual', 'commission', 'adjustment');

-- CreateEnum
CREATE TYPE "advance_status" AS ENUM ('pending_payout', 'active', 'repaid', 'cancelled');

-- CreateEnum
CREATE TYPE "account_group" AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

-- CreateEnum
CREATE TYPE "currency" AS ENUM ('PKR', 'USD');

-- CreateEnum
CREATE TYPE "journal_entry_status" AS ENUM ('draft', 'pending_approval', 'posted', 'rejected');

-- CreateEnum
CREATE TYPE "journal_source" AS ENUM ('manual', 'invoice', 'bill', 'payment', 'transfer', 'payroll', 'payroll_payment', 'advance', 'reversal', 'revaluation', 'opening');

-- CreateEnum
CREATE TYPE "party_kind" AS ENUM ('client', 'vendor');

-- CreateEnum
CREATE TYPE "payment_direction" AS ENUM ('received', 'made');

-- CreateEnum
CREATE TYPE "finance_period_status" AS ENUM ('open', 'closing', 'closed');

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "effective_from" DATE NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "grace_minutes" INTEGER NOT NULL,
    "working_weekdays" INTEGER[],
    "office_only_check_in" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "office_networks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "office_id" UUID NOT NULL,
    "cidr" TEXT NOT NULL,
    "label" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "office_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "check_in_at" TIMESTAMPTZ(3),
    "check_out_at" TIMESTAMPTZ(3),
    "check_in_ip" TEXT,
    "check_out_ip" TEXT,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "missed_checkout" BOOLEAN NOT NULL DEFAULT false,
    "auto_closed_at" TIMESTAMPTZ(3),
    "corrected_check_in_at" TIMESTAMPTZ(3),
    "corrected_check_out_at" TIMESTAMPTZ(3),
    "schedule_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "record_id" UUID,
    "requested_check_in_at" TIMESTAMPTZ(3),
    "requested_check_out_at" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "status" "correction_status" NOT NULL DEFAULT 'pending',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "yearly_days" DECIMAL(5,1),
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_entitlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "leave_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ('LV-'::text || to_char(now(), 'YYYY'::text) || '-'::text || lpad((nextval('leave_request_seq'::regclass))::text, 4, '0'::text)),
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "half_day" BOOLEAN NOT NULL DEFAULT false,
    "days" DECIMAL(5,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "leave_request_status" NOT NULL DEFAULT 'pending_manager',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "decided_by" UUID NOT NULL,
    "via" TEXT,
    "note" TEXT,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_periods" (
    "month" TEXT NOT NULL,
    "locked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_periods_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "tax_slab_sets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "effective_from" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "tax_slab_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_slabs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "set_id" UUID NOT NULL,
    "from_amount" DECIMAL(14,2) NOT NULL,
    "to_amount" DECIMAL(14,2),
    "fixed_amount" DECIMAL(14,2) NOT NULL,
    "rate" DECIMAL(7,4) NOT NULL,

    CONSTRAINT "tax_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "stage" "payroll_stage" NOT NULL DEFAULT 'draft',
    "working_days" INTEGER,
    "tax_slab_set_id" UUID,
    "calculated_at" TIMESTAMPTZ(3),
    "prepared_by" UUID,
    "prepared_at" TIMESTAMPTZ(3),
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "returned_note" TEXT,
    "journal_entry_id" UUID,
    "payment_entry_id" UUID,
    "payment_recorded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "base_salary" DECIMAL(12,2) NOT NULL,
    "allowances" DECIMAL(12,2) NOT NULL,
    "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unpaid_days" DECIMAL(5,1) NOT NULL DEFAULT 0,
    "unpaid_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxable_income" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "advance_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "other_deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,2) NOT NULL,
    "working_days" INTEGER NOT NULL,
    "present_days" INTEGER NOT NULL DEFAULT 0,
    "late_days" INTEGER NOT NULL DEFAULT 0,
    "absent_days" INTEGER NOT NULL DEFAULT 0,
    "flags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" "payroll_item_kind" NOT NULL,
    "source" "payroll_item_source" NOT NULL DEFAULT 'manual',
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "adjustment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "payroll_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "target_month" TEXT NOT NULL,
    "origin_run_id" UUID,
    "kind" "payroll_item_kind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_advances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "monthly_deduction" DECIMAL(12,2) NOT NULL,
    "start_month" TEXT NOT NULL,
    "status" "advance_status" NOT NULL DEFAULT 'pending_payout',
    "reason" TEXT NOT NULL,
    "payout_entry_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "salary_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_repayments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "advance_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_repayments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "storage_key" TEXT,
    "sha256" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "final_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "last_working_day" DATE NOT NULL,
    "source_event_id" UUID NOT NULL,
    "run_id" UUID,
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "final_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_group" "account_group" NOT NULL,
    "parent_id" UUID,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "is_bank" BOOLEAN NOT NULL DEFAULT false,
    "requires_owner_approval" BOOLEAN NOT NULL DEFAULT false,
    "is_oci" BOOLEAN NOT NULL DEFAULT false,
    "system_role" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_account_details" (
    "account_id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number_encrypted" TEXT NOT NULL,
    "account_number_last4" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "bank_account_details_pkey" PRIMARY KEY ("account_id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "party_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "address" TEXT,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "finance_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "currency" "currency" NOT NULL,
    "rate_date" DATE NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "source" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "max_amount" DECIMAL(14,2),
    "approver_level" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "approval_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_periods" (
    "month" TEXT NOT NULL,
    "status" "finance_period_status" NOT NULL DEFAULT 'open',
    "checklist" JSONB,
    "close_requested_by" UUID,
    "close_requested_at" TIMESTAMPTZ(3),
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "finance_periods_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "finance_period_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "month" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_period_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ('JE-'::text || to_char(now(), 'YYYY'::text) || '-'::text || lpad((nextval('journal_entry_seq'::regclass))::text, 4, '0'::text)),
    "entry_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "source" "journal_source" NOT NULL DEFAULT 'manual',
    "source_ref" TEXT,
    "purpose" TEXT,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "total_base" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "journal_entry_status" NOT NULL DEFAULT 'draft',
    "project_id" UUID,
    "reversal_of_id" UUID,
    "maker_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "required_level" INTEGER,
    "approved_by" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "rejected_by" UUID,
    "rejected_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entry_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "base_debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "base_credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "party_id" UUID,
    "employee_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entry_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ('INV-'::text || to_char(now(), 'YYYY'::text) || '-'::text || lpad((nextval('invoice_seq'::regclass))::text, 4, '0'::text)),
    "party_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "total" DECIMAL(14,2) NOT NULL,
    "project_id" UUID,
    "notes" TEXT,
    "journal_entry_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "account_id" UUID NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ('BILL-'::text || to_char(now(), 'YYYY'::text) || '-'::text || lpad((nextval('bill_seq'::regclass))::text, 4, '0'::text)),
    "party_id" UUID NOT NULL,
    "vendor_ref" TEXT,
    "bill_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "total" DECIMAL(14,2) NOT NULL,
    "account_id" UUID NOT NULL,
    "project_id" UUID,
    "description" TEXT NOT NULL,
    "journal_entry_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "direction" "payment_direction" NOT NULL,
    "party_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "exchange_rate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "journal_entry_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID,
    "bill_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bill_id" UUID,
    "entry_id" UUID,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bank_account_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "value_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "matched_line_id" UUID,
    "matched_by" UUID,
    "matched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "step_up_above" DECIMAL(14,2) NOT NULL,
    "finance_year_start_month" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_effective_from_key" ON "work_schedules"("effective_from");

-- CreateIndex
CREATE INDEX "office_networks_office_id_idx" ON "office_networks"("office_id");

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- CreateIndex
CREATE INDEX "attendance_records_work_date_idx" ON "attendance_records"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_employee_id_work_date_key" ON "attendance_records"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_corrections_employee_id_work_date_idx" ON "attendance_corrections"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_corrections_status_idx" ON "attendance_corrections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_key_key" ON "leave_types"("key");

-- CreateIndex
CREATE UNIQUE INDEX "leave_entitlements_employee_id_leave_type_id_year_key" ON "leave_entitlements"("employee_id", "leave_type_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_number_key" ON "leave_requests"("number");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_from_date_idx" ON "leave_requests"("employee_id", "from_date");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_decisions_request_id_idx" ON "leave_decisions"("request_id");

-- CreateIndex
CREATE INDEX "tax_slab_sets_effective_from_idx" ON "tax_slab_sets"("effective_from");

-- CreateIndex
CREATE INDEX "tax_slabs_set_id_idx" ON "tax_slabs"("set_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_number_key" ON "payroll_runs"("number");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_month_key" ON "payroll_runs"("month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_journal_entry_id_key" ON "payroll_runs"("journal_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_payment_entry_id_key" ON "payroll_runs"("payment_entry_id");

-- CreateIndex
CREATE INDEX "payroll_lines_employee_id_idx" ON "payroll_lines"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_run_id_employee_id_key" ON "payroll_lines"("run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_items_adjustment_id_key" ON "payroll_items"("adjustment_id");

-- CreateIndex
CREATE INDEX "payroll_items_run_id_employee_id_idx" ON "payroll_items"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_adjustments_target_month_idx" ON "payroll_adjustments"("target_month");

-- CreateIndex
CREATE UNIQUE INDEX "salary_advances_payout_entry_id_key" ON "salary_advances"("payout_entry_id");

-- CreateIndex
CREATE INDEX "salary_advances_employee_id_status_idx" ON "salary_advances"("employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "advance_repayments_advance_id_run_id_key" ON "advance_repayments"("advance_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_line_id_key" ON "payslips"("line_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_storage_key_key" ON "payslips"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_employee_id_month_key" ON "payslips"("employee_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "final_settlements_employee_id_key" ON "final_settlements"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "final_settlements_source_event_id_key" ON "final_settlements"("source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_system_role_key" ON "ledger_accounts"("system_role");

-- CreateIndex
CREATE INDEX "ledger_accounts_account_group_idx" ON "ledger_accounts"("account_group");

-- CreateIndex
CREATE INDEX "parties_kind_name_idx" ON "parties"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_projects_code_key" ON "finance_projects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_currency_rate_date_key" ON "exchange_rates"("currency", "rate_date");

-- CreateIndex
CREATE UNIQUE INDEX "approval_limits_approver_level_key" ON "approval_limits"("approver_level");

-- CreateIndex
CREATE INDEX "finance_period_events_month_idx" ON "finance_period_events"("month");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_number_key" ON "journal_entries"("number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversal_of_id_key" ON "journal_entries"("reversal_of_id");

-- CreateIndex
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries"("entry_date");

-- CreateIndex
CREATE INDEX "journal_entries_status_idx" ON "journal_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_source_source_ref_purpose_key" ON "journal_entries"("source", "source_ref", "purpose");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex
CREATE INDEX "journal_lines_party_id_idx" ON "journal_lines"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE INDEX "journal_entry_events_entry_id_idx" ON "journal_entry_events"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_journal_entry_id_key" ON "invoices"("journal_entry_id");

-- CreateIndex
CREATE INDEX "invoices_party_id_idx" ON "invoices"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoice_id_line_no_key" ON "invoice_lines"("invoice_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "bills_number_key" ON "bills"("number");

-- CreateIndex
CREATE UNIQUE INDEX "bills_journal_entry_id_key" ON "bills"("journal_entry_id");

-- CreateIndex
CREATE INDEX "bills_party_id_idx" ON "bills"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_journal_entry_id_key" ON "payments"("journal_entry_id");

-- CreateIndex
CREATE INDEX "payments_party_id_idx" ON "payments"("party_id");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_idx" ON "payment_allocations"("invoice_id");

-- CreateIndex
CREATE INDEX "payment_allocations_bill_id_idx" ON "payment_allocations"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_storage_key_key" ON "receipts"("storage_key");

-- CreateIndex
CREATE INDEX "receipts_bill_id_idx" ON "receipts"("bill_id");

-- CreateIndex
CREATE INDEX "receipts_entry_id_idx" ON "receipts"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_bank_account_id_sha256_key" ON "bank_statement_imports"("bank_account_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_matched_line_id_key" ON "bank_statement_lines"("matched_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_import_id_line_no_key" ON "bank_statement_lines"("import_id", "line_no");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_decisions" ADD CONSTRAINT "leave_decisions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_slabs" ADD CONSTRAINT "tax_slabs_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "tax_slab_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tax_slab_set_id_fkey" FOREIGN KEY ("tax_slab_set_id") REFERENCES "tax_slab_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "payroll_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_repayments" ADD CONSTRAINT "advance_repayments_advance_id_fkey" FOREIGN KEY ("advance_id") REFERENCES "salary_advances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "final_settlements" ADD CONSTRAINT "final_settlements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ledger_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_account_details" ADD CONSTRAINT "bank_account_details_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_period_events" ADD CONSTRAINT "finance_period_events_month_fkey" FOREIGN KEY ("month") REFERENCES "finance_periods"("month") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "finance_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_events" ADD CONSTRAINT "journal_entry_events_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "bank_statement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_line_id_fkey" FOREIGN KEY ("matched_line_id") REFERENCES "journal_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written part: rules Prisma cannot express (CHECK constraints, triggers that keep finance and payroll records
-- immutable, the double-entry balance check, closed-period and locked-month protection) and the permission changes
-- that align the catalogue with the official development plan (sections 11 to 13).
-- ===========================================================================

-- ---- CHECK constraints ----------------------------------------------------
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_hours" CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute" AND "grace_minutes" >= 0 AND "grace_minutes" < ("end_minute" - "start_minute"));
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_weekdays" CHECK (cardinality("working_weekdays") BETWEEN 1 AND 7 AND "working_weekdays" <@ ARRAY[1,2,3,4,5,6,7]);
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_late" CHECK ("late_minutes" >= 0);
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_order" CHECK ("check_out_at" IS NULL OR "check_in_at" IS NULL OR "check_out_at" >= "check_in_at");
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_something" CHECK ("requested_check_in_at" IS NOT NULL OR "requested_check_out_at" IS NOT NULL);
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_order" CHECK ("requested_check_out_at" IS NULL OR "requested_check_in_at" IS NULL OR "requested_check_out_at" >= "requested_check_in_at");
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_days" CHECK ("yearly_days" IS NULL OR "yearly_days" >= 0);
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_days" CHECK ("days" >= 0);
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_dates" CHECK ("to_date" >= "from_date" AND "days" > 0 AND (NOT "half_day" OR ("from_date" = "to_date" AND "days" = 0.5)));
ALTER TABLE "leave_decisions" ADD CONSTRAINT "leave_decisions_decision" CHECK ("decision" IN ('approved', 'rejected', 'cancelled'));
ALTER TABLE "attendance_periods" ADD CONSTRAINT "attendance_periods_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "tax_slabs" ADD CONSTRAINT "tax_slabs_values" CHECK ("from_amount" >= 0 AND ("to_amount" IS NULL OR "to_amount" > "from_amount") AND "fixed_amount" >= 0 AND "rate" >= 0 AND "rate" <= 1);
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "number" = 'PR-' || "month");
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_maker_checker" CHECK (("reviewed_by" IS NULL OR "reviewed_by" <> "prepared_by") AND ("approved_by" IS NULL OR "approved_by" <> "prepared_by"));
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_amounts" CHECK ("base_salary" >= 0 AND "allowances" >= 0 AND "bonus" >= 0 AND "unpaid_days" >= 0 AND "unpaid_deduction" >= 0 AND "taxable_income" >= 0 AND "tax" >= 0 AND "advance_deduction" >= 0 AND "other_deductions" >= 0 AND "net" >= 0 AND "working_days" >= 0);
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_amount" CHECK ("amount" > 0);
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_values" CHECK ("amount" > 0 AND "target_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_values" CHECK ("amount" > 0 AND "monthly_deduction" > 0 AND "monthly_deduction" <= "amount" AND "start_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "advance_repayments" ADD CONSTRAINT "advance_repayments_amount" CHECK ("amount" > 0);
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_positive" CHECK ("rate" > 0);
ALTER TABLE "approval_limits" ADD CONSTRAINT "approval_limits_values" CHECK ("approver_level" BETWEEN 1 AND 5 AND ("max_amount" IS NULL OR "max_amount" > 0));
ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "finance_period_events" ADD CONSTRAINT "finance_period_events_action" CHECK ("action" IN ('close_requested', 'close_approved', 'close_rejected', 'reopened'));
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_rate" CHECK ("exchange_rate" > 0 AND ("currency" <> 'PKR' OR "exchange_rate" = 1) AND "total_base" >= 0);
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_not_self_approved" CHECK ("approved_by" IS NULL OR "approved_by" <> "maker_id");
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_source" CHECK (("reversal_of_id" IS NULL) = ("source" <> 'reversal'));
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND "base_debit" >= 0 AND "base_credit" >= 0 AND ("debit" = 0 OR "credit" = 0) AND ("debit" > 0 OR "credit" > 0));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_values" CHECK ("total" > 0 AND "due_date" >= "issue_date" AND "exchange_rate" > 0 AND ("currency" <> 'PKR' OR "exchange_rate" = 1));
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_values" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "amount" >= 0);
ALTER TABLE "bills" ADD CONSTRAINT "bills_values" CHECK ("total" > 0 AND "due_date" >= "bill_date" AND "exchange_rate" > 0 AND ("currency" <> 'PKR' OR "exchange_rate" = 1));
ALTER TABLE "payments" ADD CONSTRAINT "payments_values" CHECK ("amount" > 0 AND "exchange_rate" > 0 AND ("currency" <> 'PKR' OR "exchange_rate" = 1));
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_target" CHECK ("amount" > 0 AND (("invoice_id" IS NULL) <> ("bill_id" IS NULL)));
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_size" CHECK ("size_bytes" > 0);
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_single_row" CHECK ("id" = 1 AND "step_up_above" >= 0 AND "finance_year_start_month" BETWEEN 1 AND 12);

-- One holiday per date among the active rows.
CREATE UNIQUE INDEX "holidays_active_date" ON "holidays" ("date") WHERE "archived_at" IS NULL;
-- At most one open correction per employee and day.
CREATE UNIQUE INDEX "attendance_corrections_one_pending" ON "attendance_corrections" ("employee_id", "work_date") WHERE "status" = 'pending';

-- ---- History tables accept inserts only (reuses the M1-M3 function) -------
CREATE TRIGGER "leave_decisions_insert_only" BEFORE UPDATE OR DELETE ON "leave_decisions" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "journal_entry_events_insert_only" BEFORE UPDATE OR DELETE ON "journal_entry_events" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "finance_period_events_insert_only" BEFORE UPDATE OR DELETE ON "finance_period_events" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "advance_repayments_insert_only" BEFORE UPDATE OR DELETE ON "advance_repayments" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "payslips_insert_only" BEFORE UPDATE OR DELETE ON "payslips" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "payroll_adjustments_insert_only" BEFORE UPDATE OR DELETE ON "payroll_adjustments" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();

-- ---- M7: originals are kept; locked months cannot change -------------------
CREATE FUNCTION "protect_attendance_record"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  day date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance records are never deleted' USING ERRCODE = 'P0001';
  END IF;
  day := NEW.work_date;
  IF EXISTS (SELECT 1 FROM attendance_periods p WHERE p.month = to_char(day, 'YYYY-MM')) THEN
    RAISE EXCEPTION 'attendance for % is locked (period_locked)', to_char(day, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.employee_id <> NEW.employee_id OR OLD.work_date <> NEW.work_date
       OR (OLD.check_in_at IS NOT NULL AND NEW.check_in_at IS DISTINCT FROM OLD.check_in_at)
       OR (OLD.check_out_at IS NOT NULL AND NEW.check_out_at IS DISTINCT FROM OLD.check_out_at) THEN
      RAISE EXCEPTION 'the original check-in and check-out times are kept and cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "attendance_records_protect" BEFORE INSERT OR UPDATE OR DELETE ON "attendance_records"
  FOR EACH ROW EXECUTE FUNCTION "protect_attendance_record"();

CREATE FUNCTION "protect_attendance_correction"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'correction requests are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided correction request cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_periods p WHERE p.month = to_char(NEW.work_date, 'YYYY-MM')) THEN
    RAISE EXCEPTION 'attendance for % is locked (period_locked)', to_char(NEW.work_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "attendance_corrections_protect" BEFORE INSERT OR UPDATE OR DELETE ON "attendance_corrections"
  FOR EACH ROW EXECUTE FUNCTION "protect_attendance_correction"();

CREATE FUNCTION "protect_leave_request"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'leave requests are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'cancelled') AND NOT (OLD.status = 'approved' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'a decided leave request cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.employee_id <> NEW.employee_id OR OLD.leave_type_id <> NEW.leave_type_id OR OLD.from_date <> NEW.from_date
     OR OLD.to_date <> NEW.to_date OR OLD.days <> NEW.days OR OLD.half_day <> NEW.half_day THEN
    RAISE EXCEPTION 'the dates and type of a leave request cannot change; cancel it and ask again' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM attendance_periods p
             WHERE p.month BETWEEN to_char(OLD.from_date, 'YYYY-MM') AND to_char(OLD.to_date, 'YYYY-MM'))
     AND (OLD.status = 'approved' OR NEW.status = 'approved') THEN
    RAISE EXCEPTION 'leave in a locked month cannot change (period_locked)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "leave_requests_protect" BEFORE UPDATE OR DELETE ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION "protect_leave_request"();

-- ---- M8: an approved payroll run never changes -----------------------------
CREATE FUNCTION "protect_payroll_run"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll runs are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.stage = 'approved' THEN
    -- Only the payment record may be added (once) after approval.
    IF NEW.stage <> OLD.stage OR NEW.month <> OLD.month OR NEW.number <> OLD.number
       OR NEW.working_days IS DISTINCT FROM OLD.working_days OR NEW.tax_slab_set_id IS DISTINCT FROM OLD.tax_slab_set_id
       OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR (OLD.payment_entry_id IS NOT NULL AND NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id) THEN
      RAISE EXCEPTION 'an approved payroll run cannot be changed; use an adjustment in a later month' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payroll_runs_protect" BEFORE UPDATE OR DELETE ON "payroll_runs"
  FOR EACH ROW EXECUTE FUNCTION "protect_payroll_run"();

-- Lines and items change only while the run is a draft or calculated (before it is prepared).
CREATE FUNCTION "protect_payroll_detail"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_stage payroll_stage;
BEGIN
  SELECT stage INTO run_stage FROM payroll_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  IF run_stage NOT IN ('draft', 'calculated') THEN
    RAISE EXCEPTION 'payroll lines cannot change once the run is prepared (stage %)', run_stage USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "payroll_lines_protect" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines"
  FOR EACH ROW EXECUTE FUNCTION "protect_payroll_detail"();
CREATE TRIGGER "payroll_items_protect" BEFORE INSERT OR UPDATE OR DELETE ON "payroll_items"
  FOR EACH ROW EXECUTE FUNCTION "protect_payroll_detail"();

-- ---- M9: double entry, immutability, closed periods -----------------------
-- A posted (or rejected) entry can never be edited or deleted. No entry is ever deleted.
-- An entry cannot be created or changed in a closed month.
CREATE FUNCTION "protect_journal_entry"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries are never deleted; reverse a posted entry instead' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'rejected') THEN
    RAISE EXCEPTION 'a % journal entry can never be edited (reverse it instead)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending_approval' AND (
       NEW.entry_date <> OLD.entry_date OR NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate
       OR NEW.total_base <> OLD.total_base OR NEW.maker_id <> OLD.maker_id OR NEW.source <> OLD.source) THEN
    RAISE EXCEPTION 'an entry waiting for approval cannot be edited; reject it first' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM finance_periods p WHERE p.month = to_char(NEW.entry_date, 'YYYY-MM') AND p.status = 'closed') THEN
    RAISE EXCEPTION '% is closed (period_closed)', to_char(NEW.entry_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "journal_entries_protect" BEFORE INSERT OR UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "protect_journal_entry"();

-- Lines change only while their entry is a draft.
CREATE FUNCTION "protect_journal_line"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_status journal_entry_status;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF entry_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines of a % entry cannot change', entry_status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "journal_lines_protect" BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "protect_journal_line"();

-- Debits must equal credits (in the entry currency and in PKR) before an entry can wait for approval or be posted.
-- Deferred to the end of the transaction, so the entry and its lines are written together.
CREATE FUNCTION "check_journal_balance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d numeric; c numeric; bd numeric; bc numeric; n int;
BEGIN
  IF NEW.status NOT IN ('pending_approval', 'posted') THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(debit), 0), COALESCE(sum(credit), 0), COALESCE(sum(base_debit), 0), COALESCE(sum(base_credit), 0), count(*)
    INTO d, c, bd, bc, n FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 OR d <> c OR bd <> bc OR bd <> NEW.total_base OR d = 0 THEN
    RAISE EXCEPTION 'journal entry % is not balanced (unbalanced_entry)', NEW.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "journal_entries_balanced" AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_journal_balance"();

-- A closed period changes only through the close / reopen actions; no period row is deleted.
CREATE FUNCTION "protect_finance_period"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance periods are never deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "finance_periods_protect" BEFORE DELETE ON "finance_periods"
  FOR EACH ROW EXECUTE FUNCTION "protect_finance_period"();

-- ---- Permission catalogue changes (official plan wins; see docs/M7-M9-DECISIONS.md) ---------------------------
-- On a fresh database these statements change nothing (the roles do not exist yet) and the seed creates the roles
-- from backend/prisma/permission-catalogue.ts, which has the same changes. On an existing database they apply the
-- changes once and record them in the audit log.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('finance.close_approve', 'finance', 'Approve a month close (plan section 13: the CEO approves it)')
ON CONFLICT ("key") DO NOTHING;

-- Grants added by the plan
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM (VALUES
    ('owner', 'leave.approve'), ('owner', 'attendance.approve_correction'), ('owner', 'finance.entry_approve'), ('owner', 'finance.reopen'),
    ('ceo', 'payroll.approve'), ('ceo', 'finance.entry_approve'), ('ceo', 'finance.close_approve'), ('ceo', 'finance.reopen'),
    ('level4_default', 'leave.approve'), ('level4_default', 'attendance.approve_correction'), ('level4_default', 'attendance.view_team')
  ) AS g(role_key, permission_key)
  JOIN "roles" r ON r.key = g.role_key
  JOIN "permissions" p ON p.key = g.permission_key
ON CONFLICT DO NOTHING;

-- Grants the plan gives to someone else: payroll is approved by the CEO (the Director reviews), the month close is
-- run by the finance duty person and approved by the CEO, and only the Owner or CEO reopen a closed month.
DELETE FROM "role_permissions" rp USING "roles" r, "permissions" p
WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = 'director'
  AND p.key IN ('payroll.approve', 'finance.reopen', 'finance.close');

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'm7_m9_foundation',
  'Align the permission catalogue with the official development plan, sections 11 to 13',
  '{"added": {"owner": ["leave.approve", "attendance.approve_correction", "finance.entry_approve", "finance.reopen"], "ceo": ["payroll.approve", "finance.entry_approve", "finance.close_approve", "finance.reopen"], "level4_default": ["leave.approve", "attendance.approve_correction", "attendance.view_team"]}, "removed": {"director": ["payroll.approve", "finance.reopen", "finance.close"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");
