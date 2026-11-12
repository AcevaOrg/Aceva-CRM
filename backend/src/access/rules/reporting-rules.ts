/**
 * Rules for who may report to whom (plan section 5, decision C2).
 *
 * Level and reporting line are separate ideas:
 *  - Normally a person reports to someone at a STRICTLY HIGHER level (smaller number).
 *  - Same-level reporting is allowed only for pairs listed in `sameLevelRules`
 *    (today: the CTO reports to the Director, both Level 3).
 *  - Nobody reports to someone below them, to themselves, or in a loop.
 *  - Level 1 (Owner) has nobody above them.
 *
 * These functions are pure (no database) so they are easy to test.
 */

export interface RulePerson {
  id: string;
  empId: string;
  levelNumber: number;
  roleId: string;
  status: 'active' | 'on_notice' | 'left';
}

export interface SameLevelRule {
  managerRoleId: string;
  employeeRoleId: string;
}

export type ReportingViolationCode =
  | 'owner_has_no_manager'
  | 'self'
  | 'cycle'
  | 'manager_left'
  | 'employee_left'
  | 'manager_below_employee'
  | 'same_level_not_allowed';

export interface ReportingViolation {
  code: ReportingViolationCode;
  message: string;
}

/** Checks only the level and status rules for one employee/manager pair. */
export function checkLevelRules(
  employee: RulePerson,
  manager: RulePerson,
  sameLevelRules: SameLevelRule[],
): ReportingViolation[] {
  const problems: ReportingViolation[] = [];

  if (employee.levelNumber === 1) {
    problems.push({ code: 'owner_has_no_manager', message: `${employee.empId} is Level 1 and has nobody above them` });
    return problems;
  }
  if (employee.status === 'left') {
    problems.push({ code: 'employee_left', message: `${employee.empId} has left the company` });
  }
  if (manager.status === 'left') {
    problems.push({ code: 'manager_left', message: `${manager.empId} has left the company` });
  }
  if (manager.levelNumber > employee.levelNumber) {
    problems.push({
      code: 'manager_below_employee',
      message: `${manager.empId} (Level ${manager.levelNumber}) is below ${employee.empId} (Level ${employee.levelNumber})`,
    });
  } else if (manager.levelNumber === employee.levelNumber) {
    const allowed = sameLevelRules.some(
      (r) => r.managerRoleId === manager.roleId && r.employeeRoleId === employee.roleId,
    );
    if (!allowed) {
      problems.push({
        code: 'same_level_not_allowed',
        message: `Same-level reporting between ${employee.empId} and ${manager.empId} (both Level ${employee.levelNumber}) is not configured`,
      });
    }
  }
  return problems;
}

/**
 * Full check for setting `employee`'s reporting person to `manager`.
 * `employeeDownlineIds` = everyone already below `employee` (used to prevent loops).
 */
export function checkReportingLine(
  employee: RulePerson,
  manager: RulePerson,
  sameLevelRules: SameLevelRule[],
  employeeDownlineIds: ReadonlySet<string>,
): ReportingViolation[] {
  if (manager.id === employee.id) {
    return [{ code: 'self', message: 'A person cannot report to themselves' }];
  }
  if (employeeDownlineIds.has(manager.id)) {
    return [
      {
        code: 'cycle',
        message: `${manager.empId} already reports (directly or indirectly) to ${employee.empId}; this would create a reporting loop`,
      },
    ];
  }
  return checkLevelRules(employee, manager, sameLevelRules);
}
