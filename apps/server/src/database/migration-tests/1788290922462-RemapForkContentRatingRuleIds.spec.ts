import { DataSource } from 'typeorm';
import { RemapForkContentRatingRuleIds1788290922462 } from '../migrations/1788290922462-RemapForkContentRatingRuleIds';

describe('RemapForkContentRatingRuleIds migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      entities: [],
    });
    await dataSource.initialize();
    // Minimal stand-in for the `rules` table (only the columns the migration
    // reads/writes), matching the NormalizeRuleSectionOperators spec.
    await dataSource.query(
      `CREATE TABLE "rules" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "ruleJson" text NOT NULL,
        "ruleGroupId" integer NOT NULL,
        "section" integer NOT NULL DEFAULT (0),
        "isActive" boolean NOT NULL DEFAULT (1)
      )`,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const insertRule = (id: number, rule: Record<string, unknown>) =>
    dataSource.query(
      `INSERT INTO "rules" ("id", "ruleGroupId", "section", "ruleJson") VALUES (?, 1, 0, ?)`,
      [id, JSON.stringify(rule)],
    );

  const run = async (direction: 'up' | 'down' = 'up') => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      const migration = new RemapForkContentRatingRuleIds1788290922462();
      await migration[direction](queryRunner);
    } finally {
      await queryRunner.release();
    }
  };

  const ruleById = async (id: number): Promise<Record<string, any>> => {
    const rows: Array<{ ruleJson: string }> = await dataSource.query(
      `SELECT "ruleJson" FROM "rules" WHERE "id" = ?`,
      [id],
    );
    return JSON.parse(rows[0].ruleJson);
  };

  // A text comparison against a constant - how a content rating rule is
  // written in practice.
  const contentRatingRule = (applicationId: number, propertyId: number) => ({
    operator: null,
    action: 2, // EQUALS
    firstVal: [applicationId, propertyId],
    customVal: { ruleTypeId: 2, value: 'TV-MA' },
    section: 0,
  });

  it('moves Plex, Jellyfin and Emby content rating rules to the reserved id', async () => {
    await insertRule(1, contentRatingRule(0, 48));
    await insertRule(2, contentRatingRule(6, 48));
    await insertRule(3, contentRatingRule(7, 48));

    await run();

    expect((await ruleById(1)).firstVal).toEqual([0, 1000]);
    expect((await ruleById(2)).firstVal).toEqual([6, 1000]);
    expect((await ruleById(3)).firstVal).toEqual([7, 1000]);
  });

  it('preserves the comparator and constant it was saved with', async () => {
    await insertRule(1, contentRatingRule(0, 48));

    await run();

    const rule = await ruleById(1);
    expect(rule.action).toBe(2);
    expect(rule.customVal).toEqual({ ruleTypeId: 2, value: 'TV-MA' });
  });

  it('moves Radarr and Sonarr certification rules unconditionally', async () => {
    await insertRule(1, contentRatingRule(1, 27));
    await insertRule(2, contentRatingRule(2, 36));

    await run();

    expect((await ruleById(1)).firstVal).toEqual([1, 1000]);
    expect((await ruleById(2)).firstVal).toEqual([2, 1000]);
  });

  it("leaves upstream's DATE season rule at 48", async () => {
    // sw_lastViewedAtThroughSeason, as a database seeded from upstream holds it.
    await insertRule(1, {
      operator: null,
      action: 5, // BEFORE
      firstVal: [0, 48],
      customVal: { ruleTypeId: 1, value: '30' },
      section: 0,
    });

    await run();

    expect((await ruleById(1)).firstVal).toEqual([0, 48]);
  });

  it("leaves a DATE-only comparison at 48 when there is no constant to type off", async () => {
    await insertRule(1, {
      operator: null,
      action: 6, // AFTER
      firstVal: [0, 48],
      lastVal: [0, 7],
      section: 0,
    });

    await run();

    expect((await ruleById(1)).firstVal).toEqual([0, 48]);
  });

  it('moves a property-to-property content rating comparison on both sides', async () => {
    await insertRule(1, {
      operator: null,
      action: 2, // EQUALS
      firstVal: [0, 48],
      lastVal: [6, 48],
      section: 0,
    });

    await run();

    const rule = await ruleById(1);
    expect(rule.firstVal).toEqual([0, 1000]);
    expect(rule.lastVal).toEqual([6, 1000]);
  });

  it('leaves other properties and other applications alone', async () => {
    await insertRule(1, contentRatingRule(0, 47)); // Plex lastPlayedAt
    await insertRule(2, contentRatingRule(4, 48)); // Tautulli, no such move
    await insertRule(3, contentRatingRule(1, 26)); // Radarr, below the moved id

    await run();

    expect((await ruleById(1)).firstVal).toEqual([0, 47]);
    expect((await ruleById(2)).firstVal).toEqual([4, 48]);
    expect((await ruleById(3)).firstVal).toEqual([1, 26]);
  });

  it('leaves unparseable rows untouched', async () => {
    await dataSource.query(
      `INSERT INTO "rules" ("id", "ruleGroupId", "section", "ruleJson") VALUES (1, 1, 0, 'not json')`,
    );

    await expect(run()).resolves.not.toThrow();

    const rows: Array<{ ruleJson: string }> = await dataSource.query(
      `SELECT "ruleJson" FROM "rules" WHERE "id" = 1`,
    );
    expect(rows[0].ruleJson).toBe('not json');
  });

  it('is reversible', async () => {
    await insertRule(1, contentRatingRule(0, 48));
    await insertRule(2, contentRatingRule(6, 48));
    await insertRule(3, contentRatingRule(1, 27));
    await insertRule(4, contentRatingRule(2, 36));

    await run('up');
    await run('down');

    expect((await ruleById(1)).firstVal).toEqual([0, 48]);
    expect((await ruleById(2)).firstVal).toEqual([6, 48]);
    expect((await ruleById(3)).firstVal).toEqual([1, 27]);
    expect((await ruleById(4)).firstVal).toEqual([2, 36]);
  });
});
