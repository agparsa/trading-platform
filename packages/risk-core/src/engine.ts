import type { ProposedOrder, RiskContext, RiskDecision, RiskRule, RiskViolation } from './types';

/**
 * Evaluates every configured rule and reports all violations.
 *
 * Deliberately not short-circuiting: a trader whose order breaks three limits
 * should be told all three, not sent round the loop three times.
 *
 * This engine is the extension point for future products. A prop-firm layer
 * adds drawdown, profit-target and consistency rules by supplying additional
 * `RiskRule` implementations — it does not modify the trading engine, and none
 * of that logic belongs in this repository.
 */
export class RiskEngine {
  private readonly rules: readonly RiskRule[];

  constructor(rules: readonly RiskRule[]) {
    const names = new Set<string>();
    for (const rule of rules) {
      if (names.has(rule.name)) throw new Error(`Duplicate risk rule name: ${rule.name}`);
      names.add(rule.name);
    }
    this.rules = rules;
  }

  evaluate(order: ProposedOrder, context: RiskContext): RiskDecision {
    const violations: RiskViolation[] = [];
    for (const rule of this.rules) {
      const violation = rule.evaluate(order, context);
      if (violation !== null) violations.push(violation);
    }
    return { allowed: violations.length === 0, violations };
  }

  ruleNames(): readonly string[] {
    return this.rules.map((r) => r.name);
  }
}
