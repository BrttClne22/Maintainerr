import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves this fork's content rating / certification rule properties out of
 * upstream's rule-property id range and into a reserved block at 1000.
 *
 * Stored rules address a property positionally, as `[applicationId,
 * propertyId]` inside `rules.ruleJson`, so a property id is a persisted key.
 * The fork numbered its own properties from the next free id in each
 * application, which put them directly in the path of upstream's next
 * addition. Upstream 3.26.0 then claimed Plex/Jellyfin 48 for
 * `sw_lastViewedAtThroughSeason`, colliding with `contentRating`. Left alone,
 * every stored content rating rule would silently resolve to that DATE
 * property instead - not an error, a rule that quietly evaluates the wrong
 * thing and changes which media a collection takes in.
 *
 * Renumbering into a reserved block ends the collision for good: upstream can
 * keep taking 49, 50, ... without ever reaching the fork's properties. The
 * moves are:
 *   Plex (0), Jellyfin (6), Emby (7)  contentRating   48 -> 1000
 *   Radarr (1)                        certification   27 -> 1000
 *   Sonarr (2)                        certification   36 -> 1000
 * Emby shares Jellyfin's props array in RuleConstants, so it shares the ids.
 *
 * The Radarr and Sonarr moves are unconditional - upstream has never issued
 * those ids (its highest are 26 and 35), so 27/36 can only be this fork's.
 *
 * The 48 moves are guarded. On a database that has run this fork, 48 has only
 * ever meant `contentRating`, because upstream's 48 arrives in the same merge
 * as this migration and no build before it carried both. The guard exists for
 * a database seeded from an upstream build instead, where 48 legitimately
 * means the season view frontier: a rule that is provably DATE-typed is left
 * where it is. Everything else is treated as this fork's TEXT property.
 */

const CONTENT_RATING_MOVES = [
  { applicationId: 0, from: 48 }, // Plex
  { applicationId: 6, from: 48 }, // Jellyfin
  { applicationId: 7, from: 48 }, // Emby
] as const;

const CERTIFICATION_MOVES = [
  { applicationId: 1, from: 27 }, // Radarr
  { applicationId: 2, from: 36 }, // Sonarr
] as const;

const RESERVED_ID = 1000;

/** RuleType ids as persisted in `customVal.ruleTypeId`. */
const RULE_TYPE_DATE = 1;

/** RulePossibility members that only a DATE property offers. */
const DATE_ONLY_ACTIONS = new Set([
  5, // BEFORE
  6, // AFTER
  7, // IN_LAST
  8, // IN_NEXT
]);

type StoredOperand = [number, number];

interface StoredRule {
  action?: unknown;
  firstVal?: StoredOperand;
  lastVal?: StoredOperand;
  customVal?: { ruleTypeId?: unknown; value?: unknown };
}

/**
 * True when the rule can be shown to be upstream's DATE property rather than
 * this fork's TEXT one. Only a positive proof of DATE keeps a rule in place.
 */
function isUpstreamDateRule(rule: StoredRule): boolean {
  const ruleTypeId = rule.customVal?.ruleTypeId;
  if (ruleTypeId !== undefined && ruleTypeId !== null) {
    return Number(ruleTypeId) === RULE_TYPE_DATE;
  }

  // No constant to type off: a property-to-property comparison. A DATE-only
  // comparator proves both operands are dates.
  return DATE_ONLY_ACTIONS.has(Number(rule.action));
}

export class RemapForkContentRatingRuleIds1788290922462
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await remap(queryRunner, RESERVED_ID);
  }

  /**
   * Reversible: the same rows are moved back to the ids they came from. The
   * reverse direction needs no guard, because 1000 is this fork's alone.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await remap(queryRunner, RESERVED_ID, true);
  }
}

async function remap(
  queryRunner: QueryRunner,
  reservedId: number,
  reverse = false,
): Promise<void> {
  const rows: Array<{ id: number; ruleJson: string }> = await queryRunner.manager
    .createQueryBuilder()
    .select('rule.id', 'id')
    .addSelect('rule.ruleJson', 'ruleJson')
    .from('rules', 'rule')
    .orderBy('rule.id', 'ASC')
    .getRawMany();

  for (const row of rows) {
    let parsed: StoredRule;
    try {
      parsed = JSON.parse(row.ruleJson);
    } catch {
      // Leave unparseable rows untouched; they are not ours to fix here.
      continue;
    }

    let changed = false;

    for (const move of CERTIFICATION_MOVES) {
      const from = reverse ? reservedId : move.from;
      const to = reverse ? move.from : reservedId;
      changed = applyMove(parsed, move.applicationId, from, to) || changed;
    }

    for (const move of CONTENT_RATING_MOVES) {
      if (!reverse && isUpstreamDateRule(parsed)) {
        continue;
      }
      const from = reverse ? reservedId : move.from;
      const to = reverse ? move.from : reservedId;
      changed = applyMove(parsed, move.applicationId, from, to) || changed;
    }

    if (!changed) {
      continue;
    }

    await queryRunner.manager
      .createQueryBuilder()
      .update('rules')
      .set({ ruleJson: JSON.stringify(parsed) })
      .where('id = :id', { id: row.id })
      .execute();
  }
}

function applyMove(
  rule: StoredRule,
  applicationId: number,
  from: number,
  to: number,
): boolean {
  let changed = false;
  for (const key of ['firstVal', 'lastVal'] as const) {
    const operand = rule[key];
    if (
      Array.isArray(operand) &&
      operand.length >= 2 &&
      Number(operand[0]) === applicationId &&
      Number(operand[1]) === from
    ) {
      operand[1] = to;
      changed = true;
    }
  }
  return changed;
}
