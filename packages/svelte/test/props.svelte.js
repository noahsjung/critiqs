/**
 * Reactive props for a component mounted from a test: changing a property
 * re-renders it, like a parent passing new values.
 * @template {object} T
 * @param {T} initial
 * @returns {T}
 */
export function reactiveProps(initial) {
  const props = $state(initial);
  return props;
}
