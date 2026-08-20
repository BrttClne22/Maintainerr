import { type MediaItemType } from '@maintainerr/contracts';
import { createRuleGroupDto } from '../../../../test/utils/data';
import { type RuleGroupDto } from '../dtos/ruleGroup.dto';
import {
  countRuleCollectionNames,
  filterRuleCollectionNames,
  getParentBackedRuleItem,
  mapMatchingRuleUsersToNames,
  mapRuleUserIdsToNames,
  normalizeContentRating,
  uniqueTrimmedRulePropertyNames,
} from './rule-property.helper';

interface TestUser {
  id: string;
  name: string;
}

const createRuleGroup = (): RuleGroupDto =>
  createRuleGroupDto({
    name: 'Cleanup Collection',
    collection: {
      manualCollectionName: 'Manual Cleanup',
    } as RuleGroupDto['collection'],
  });

describe('rule-property.helper', () => {
  describe('collection helpers', () => {
    it('filters the rule collection and manual collection case-insensitively', () => {
      const collectionNames = [
        ' Franchise ',
        'cleanup collection',
        'Manual Cleanup',
        'Documentaries',
      ];

      expect(
        filterRuleCollectionNames(collectionNames, createRuleGroup()),
      ).toEqual(['Franchise', 'Documentaries']);
    });

    it('counts only collections that survive rule collection filtering', () => {
      expect(
        countRuleCollectionNames(
          ['Cleanup Collection', 'Manual Cleanup', 'Other Collection'],
          createRuleGroup(),
        ),
      ).toBe(1);
    });

    it('de-duplicates on the raw value, then trims (preserves #1630 behaviour)', () => {
      // Exact raw duplicates collapse ('Saga' x2 -> one). A value that differs
      // only in surrounding whitespace (' Saga ') is de-duplicated BEFORE the
      // trim, so it survives as its own entry -> a post-trim duplicate. Same for
      // a case variant ('saga'). This list length is what COUNT_* rules see.
      expect(
        uniqueTrimmedRulePropertyNames([
          'Saga',
          'Saga',
          ' Saga ',
          'saga',
          'Movies',
        ]),
      ).toEqual(['Saga', 'Saga', 'saga', 'Movies']);
    });

    it('returns an empty list for empty input', () => {
      expect(uniqueTrimmedRulePropertyNames([])).toEqual([]);
    });

    it('preserves first-seen order', () => {
      expect(
        uniqueTrimmedRulePropertyNames(['Beta', 'Alpha', 'Beta', 'Gamma']),
      ).toEqual(['Beta', 'Alpha', 'Gamma']);
    });
  });

  describe('user mapping helpers', () => {
    const users: TestUser[] = [
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ];

    it('maps backend user ids to display names and keeps unknown ids visible', () => {
      expect(
        mapRuleUserIdsToNames(
          ['u2', 'missing'],
          users,
          (user) => user.id,
          (user) => user.name,
        ),
      ).toEqual(['Bob', 'missing']);
    });

    it('falls back to the backend user id when a mapped name is blank', () => {
      expect(
        mapRuleUserIdsToNames(
          ['u2', 'missing', 'u1'],
          [
            { id: 'u1', name: 'Alice' },
            { id: 'u2', name: '  ' },
          ],
          (user) => user.id,
          (user) => user.name,
        ),
      ).toEqual(['u2', 'missing', 'Alice']);
    });

    it('matches known users once in configured user order', () => {
      expect(
        mapMatchingRuleUsersToNames(
          ['u2', 'u2', 'u1'],
          users,
          (user) => user.id,
          (user) => user.name,
        ),
      ).toEqual(['Alice', 'Bob']);
    });
  });

  describe('parent-backed metadata helper', () => {
    it.each([
      ['episode', 'show'],
      ['season', 'season'],
      ['movie', 'movie'],
    ] as Array<[MediaItemType, string]>)(
      'selects %s rule metadata from the expected level',
      async (mediaType, expectedTitle) => {
        const item = { title: 'movie' };
        const parent = { title: 'season' };
        const grandparent = { title: 'show' };

        await expect(
          getParentBackedRuleItem(
            mediaType,
            item,
            async () => parent,
            async () => grandparent,
          ),
        ).resolves.toEqual({ title: expectedTitle });
      },
    );
  });

  describe('content rating normalisation', () => {
    it.each([
      ['us/PG-13', 'PG-13'],
      ['gb/15', '15'],
      ['de/16', '16'],
      ['DE/16', '16'],
      ['PG-13', 'PG-13'],
      ['  TV-MA  ', 'TV-MA'],
    ])('reduces %s to the bare certification %s', (raw, expected) => {
      expect(normalizeContentRating(raw)).toBe(expected);
    });

    // The state that makes Plex hide an item from managed users. It has to be
    // distinguishable from a rating that merely failed to normalise, because
    // `does not exist` is the rule people write to find these.
    it.each([undefined, null, '', '   ', 'us/'])(
      'reports %p as no rating at all',
      (raw) => {
        expect(normalizeContentRating(raw)).toBeNull();
      },
    );

    // NR is a classification someone applied, not missing data. Folding it
    // into null would make the two impossible to tell apart in a rule.
    it.each(['NR', 'Unrated', 'Not Rated', 'us/NR'])(
      'keeps the explicit %s classification intact',
      (raw) => {
        expect(normalizeContentRating(raw)).toBe(raw.replace('us/', ''));
      },
    );

    // A four-letter certification must not lose its first two characters to
    // the region strip - the prefix is only ever two letters plus a slash.
    it('only strips a two-letter prefix that ends in a slash', () => {
      expect(normalizeContentRating('TV-Y7-FV')).toBe('TV-Y7-FV');
      expect(normalizeContentRating('R')).toBe('R');
    });
  });
});
