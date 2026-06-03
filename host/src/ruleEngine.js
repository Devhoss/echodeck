const CONDITION_TYPES = new Set([
  "process",
  "window_title",
  "executable_path",
  "browser_url",
]);

const OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "regex",
  "exists",
]);

function findMatchingRule(rules, context) {
  const enabledRules = rules
    .filter((rule) => rule?.enabled && Array.isArray(rule.conditions))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  return enabledRules.find((rule) => matchesRule(rule, context)) || null;
}

function matchesRule(rule, context) {
  const conditions = rule.conditions.filter(isValidCondition);
  if (conditions.length === 0) return false;

  const results = conditions.map((condition) =>
    matchesCondition(condition, context),
  );
  return String(rule.logic || "AND").toUpperCase() === "OR"
    ? results.some(Boolean)
    : results.every(Boolean);
}

function matchesCondition(condition, context) {
  const actual = getContextValue(condition.type, context);
  const expected = String(condition.value ?? "");
  const operator = condition.operator || "equals";

  if (operator === "exists") return Boolean(actual);
  if (!actual && actual !== "") return false;

  const actualText = String(actual);
  const actualLower = actualText.toLowerCase();
  const expectedLower = expected.toLowerCase();

  switch (operator) {
    case "equals":
      return actualLower === expectedLower;
    case "not_equals":
      return actualLower !== expectedLower;
    case "contains":
      return actualLower.includes(expectedLower);
    case "not_contains":
      return !actualLower.includes(expectedLower);
    case "starts_with":
      return actualLower.startsWith(expectedLower);
    case "ends_with":
      return actualLower.endsWith(expectedLower);
    case "regex":
      return safeRegexTest(expected, actualText);
    default:
      return false;
  }
}

function getContextValue(type, context) {
  return (
    {
      process: context?.process,
      window_title: context?.windowTitle,
      executable_path: context?.executablePath,
      browser_url: context?.browserUrl,
    }[type] ?? ""
  );
}

function isValidCondition(condition) {
  return (
    condition &&
    CONDITION_TYPES.has(condition.type) &&
    OPERATORS.has(condition.operator || "equals") &&
    (condition.operator === "exists" || String(condition.value ?? "").trim())
  );
}

function safeRegexTest(pattern, value) {
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

module.exports = {
  findMatchingRule,
  matchesRule,
  matchesCondition,
};
