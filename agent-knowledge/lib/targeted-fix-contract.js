const TARGETED_FIX_CATEGORY_BY_TYPE = Object.freeze({
  bug: 'fixes',
  prd: 'prd-corrections',
  tech: 'tech-solution-corrections',
});
const TARGETED_FIX_CATEGORIES = new Set(Object.values(TARGETED_FIX_CATEGORY_BY_TYPE));

export function getTargetedFixCategory(type) {
  return Object.hasOwn(TARGETED_FIX_CATEGORY_BY_TYPE, type)
    ? TARGETED_FIX_CATEGORY_BY_TYPE[type]
    : undefined;
}

export function isTargetedFixCategory(category) {
  return TARGETED_FIX_CATEGORIES.has(category);
}
