/**
 * Social Security, which for most households is the largest single line in
 * retirement and was the one the forecast did not have.
 *
 * Without it the walk shows a cliff at the retirement age that nobody's life
 * actually has: pay stops, nothing replaces it, and the savings carry the
 * whole load. The figure itself has to come off a statement at ssa.gov,
 * because it is worked out from a lifetime of earnings this app has never
 * seen. Everything after that is rules, and the rules are worth getting right
 * rather than approximating, because the whole reason to model this is to
 * compare claiming early against claiming late.
 *
 * All the percentages below are the published ones. The two well-known
 * headline numbers fall out of them rather than being hard-coded: someone with
 * a full retirement age of 67 gets 70% by claiming at 62 and 124% by waiting
 * until 70.
 */

/** Nobody may claim before this. */
export const EARLIEST_CLAIM = 62;
/** Waiting past this earns nothing further, so the dial stops here. */
export const LATEST_CLAIM = 70;

/**
 * Full retirement age, in years, from the year somebody was born.
 *
 * Two months per birth year through each transition, which is why this is a
 * table rather than a formula. Anyone born from 1960 on has the same answer,
 * so in practice this matters for people already close to claiming.
 */
export function fullRetirementAge(birthYear: number): number {
  if (birthYear <= 1937) return 65;
  if (birthYear <= 1942) return 65 + (birthYear - 1937) * 2 / 12;
  if (birthYear <= 1954) return 66;
  if (birthYear <= 1959) return 66 + (birthYear - 1954) * 2 / 12;
  return 67;
}

/**
 * What a worker's own benefit is multiplied by, claiming at `claimAge`.
 *
 * Early is penalised at 5/9 of a percent a month for the first three years and
 * the gentler 5/12 after that; late earns 2/3 of a percent a month up to 70.
 * Both early rates matter. At a full retirement age of 67, using either one on
 * its own for the whole five years gives 66.7% or 75% where the answer is 70%,
 * and the error is permanent.
 */
export function ownFactor(fra: number, claimAge: number): number {
  const age = Math.min(LATEST_CLAIM, Math.max(EARLIEST_CLAIM, claimAge));
  const months = Math.round((age - fra) * 12);
  if (months === 0) return 1;
  if (months > 0) return 1 + (months * 2 / 3) / 100;
  const early = -months;
  const first = Math.min(36, early);
  const rest = Math.max(0, early - 36);
  return 1 - ((first * 5 / 9) + (rest * 5 / 12)) / 100;
}

/**
 * What a spouse gets on the worker's record, as a share of the worker's
 * benefit at full retirement age.
 *
 * Half at their own full retirement age, less 25/36 of a percent for each of
 * the first thirty-six months early and 5/12 after that. There is no credit
 * for waiting: a spousal benefit is worth no more at 70 than at full
 * retirement age, which is the single most expensive thing people get wrong
 * about it.
 */
export function spousalFactor(fra: number, claimAge: number): number {
  const age = Math.min(LATEST_CLAIM, Math.max(EARLIEST_CLAIM, claimAge));
  const early = Math.max(0, Math.round((fra - age) * 12));
  const first = Math.min(36, early);
  const rest = Math.max(0, early - 36);
  return 0.5 * (1 - ((first * 25 / 36) + (rest * 5 / 12)) / 100);
}

export interface SocialSecurity {
  /** The monthly figure at full retirement age, in today's money, off ssa.gov. */
  monthlyAtFRA: number;
  /** The age this household's earner starts drawing it. */
  claimAge: number;
  /**
   * How much of the benefit is taxed, as a proportion.
   *
   * Between nothing and 85% depending on everything else coming in that year,
   * which the walk does not model. 85% is the band a household with real
   * retirement savings lands in, so it is the honest default and it is a
   * number on the page rather than a constant in here.
   */
  taxablePct: number;
  /** A second person on the same plan, with their own record and their own age. */
  spouse?: { monthlyAtFRA: number; claimAge: number; birthYear: number };
}

export const DEFAULT_SOCIAL_SECURITY: SocialSecurity = {
  monthlyAtFRA: 0,
  claimAge: 67,
  taxablePct: 85,
};

/** Nothing entered anywhere, so the walk should not go looking. */
export const hasBenefit = (ss?: SocialSecurity): boolean =>
  Boolean(ss && (ss.monthlyAtFRA > 0 || (ss.spouse && ss.spouse.monthlyAtFRA > 0)));

/** One person's own benefit a month, in today's money, before tax. */
export const ownBenefit = (monthlyAtFRA: number, birthYear: number, claimAge: number): number =>
  monthlyAtFRA * ownFactor(fullRetirementAge(birthYear), claimAge);

/**
 * What the household draws in a given month, in today's money, after tax.
 *
 * Ages rather than dates, because everything else in the walk is expressed in
 * ages and because the two people are rarely the same age. Three rules decide
 * it, and each of them is a real one:
 *
 *   - Nobody draws before the age they said they would claim.
 *   - A spouse gets their own benefit or half of the worker's, whichever is
 *     larger, never both.
 *   - The spousal half is not payable until the worker has actually filed, so
 *     a younger spouse claiming first gets their own record until then.
 */
export function benefitAt(
  ss: SocialSecurity,
  birthYear: number,
  age: number,
  spouseAge: number,
  taxRatePct: number,
): number {
  let gross = 0;
  const filed = age >= ss.claimAge;
  if (filed) gross += ownBenefit(ss.monthlyAtFRA, birthYear, ss.claimAge);

  const sp = ss.spouse;
  if (sp && spouseAge >= sp.claimAge) {
    const own = ownBenefit(sp.monthlyAtFRA, sp.birthYear, sp.claimAge);
    const onYours = filed
      ? ss.monthlyAtFRA * spousalFactor(fullRetirementAge(sp.birthYear), sp.claimAge)
      : 0;
    gross += Math.max(own, onYours);
  }

  if (gross <= 0) return 0;
  const tax = Math.min(0.95, Math.max(0, taxRatePct / 100)) * Math.min(1, Math.max(0, ss.taxablePct / 100));
  return gross * (1 - tax);
}

/** The age the household first draws anything, for marking on a chart. */
export function firstClaimAge(ss: SocialSecurity): number | null {
  const ages: number[] = [];
  if (ss.monthlyAtFRA > 0) ages.push(ss.claimAge);
  if (ss.spouse && ss.spouse.monthlyAtFRA > 0) ages.push(ss.spouse.claimAge);
  return ages.length ? Math.min(...ages) : null;
}
