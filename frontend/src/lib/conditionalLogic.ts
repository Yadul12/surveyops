import type { ConditionalLogic } from '@/types';

export function evaluateConditionalLogic(
  logic: ConditionalLogic | null | undefined,
  answers: Record<string, unknown>
): boolean {
  if (!logic || !logic.rules || logic.rules.length === 0) {
    return true;
  }

  const operator = logic.operator || 'all';
  const results = logic.rules.map((rule) => {
    const actual = answers[rule.question_key];
    const expected = rule.value;

    switch (rule.condition) {
      case 'equals':
        return actual !== undefined && actual !== null
          ? String(actual).trim().toLowerCase() === String(expected).trim().toLowerCase()
          : false;
      case 'not_equals':
        return actual !== undefined && actual !== null
          ? String(actual).trim().toLowerCase() !== String(expected).trim().toLowerCase()
          : false;
      case 'contains':
        if (Array.isArray(actual)) {
          return actual.map((x) => String(x).toLowerCase()).includes(String(expected).toLowerCase());
        }
        return actual !== undefined && actual !== null
          ? String(actual).toLowerCase().includes(String(expected).toLowerCase())
          : false;
      case 'in':
        if (Array.isArray(expected)) {
          return actual !== undefined && actual !== null
            ? expected.map((x) => String(x).toLowerCase()).includes(String(actual).toLowerCase())
            : false;
        }
        return false;
      case 'greater_than': {
        const a = Number(actual);
        const b = Number(expected);
        return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
      }
      case 'less_than': {
        const a = Number(actual);
        const b = Number(expected);
        return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
      }
      case 'is_answered':
        return actual !== undefined && actual !== null && actual !== '' && !(Array.isArray(actual) && actual.length === 0);
      default:
        return true;
    }
  });

  return operator === 'all' ? results.every(Boolean) : results.some(Boolean);
}
