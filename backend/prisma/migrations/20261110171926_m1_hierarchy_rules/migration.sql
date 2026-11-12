-- DropForeignKey
ALTER TABLE "stand_ins" DROP CONSTRAINT "stand_ins_stand_in_id_fkey";

-- AlterTable
ALTER TABLE "stand_ins" ALTER COLUMN "stand_in_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "same_level_reporting_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "manager_role_id" UUID NOT NULL,
    "employee_role_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "same_level_reporting_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "same_level_reporting_rules_manager_role_id_employee_role_id_key" ON "same_level_reporting_rules"("manager_role_id", "employee_role_id");

-- AddForeignKey
ALTER TABLE "stand_ins" ADD CONSTRAINT "stand_ins_stand_in_id_fkey" FOREIGN KEY ("stand_in_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "same_level_reporting_rules" ADD CONSTRAINT "same_level_reporting_rules_manager_role_id_fkey" FOREIGN KEY ("manager_role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "same_level_reporting_rules" ADD CONSTRAINT "same_level_reporting_rules_employee_role_id_fkey" FOREIGN KEY ("employee_role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: a person's role must belong to the person's level.
-- (Level and reporting line are separate; a role such as "Director" only exists at Level 3.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION "enforce_role_matches_level"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = NEW."role_id" AND "level_id" = NEW."level_id") THEN
    RAISE EXCEPTION 'The role does not belong to the employee''s level'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "employees_role_matches_level" BEFORE INSERT OR UPDATE OF "role_id", "level_id" ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "enforce_role_matches_level"();
