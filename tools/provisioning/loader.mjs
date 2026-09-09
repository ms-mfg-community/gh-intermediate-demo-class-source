/**
 * Resolution hook that lets Node's built-in type stripping run this tool
 * directly from source.
 *
 * The repository writes `./module.js` in its import specifiers, which is the
 * TypeScript convention for emitted ESM. Node resolves specifiers literally,
 * so it looks for a `.js` file that only exists as `.ts`. This hook tries the
 * TypeScript file first and falls back to the original specifier, which keeps
 * the source importable by Jest, by the bundler and by Node without any of
 * them needing a different convention.
 */

/**
 * Resolves a module specifier, preferring a sibling TypeScript source.
 *
 * @param {string} specifier Requested specifier.
 * @param {object} context Resolution context supplied by Node.
 * @param {Function} nextResolve The next hook in the chain.
 * @returns {Promise<object>} The resolution result.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    } catch {
      // No TypeScript sibling, so fall through to the original specifier.
    }
  }

  return nextResolve(specifier, context)
}
