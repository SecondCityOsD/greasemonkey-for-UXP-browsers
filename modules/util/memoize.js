/**
 * @file memoize.js
 * @overview Provides a bounded memoization wrapper for pure functions, caching
 * up to a configurable number of results to balance performance and memory use.
 */

// Decorate a function with a memoization wrapper, with a limited-size cache
// to reduce peak memory utilization.
//
// Simple usage:
//
// function foo(arg1, arg2) { /* complex operation */ }
// foo = GM_util.memoize(foo);
//
// The memoized function may have any number of arguments,
// but they must be be serializable, and uniquely.
// It's safest to use this only on functions that accept primitives.

const EXPORTED_SYMBOLS = ["memoize"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}


const LIMIT_DEF = 3000;

/**
 * Wraps a function with a bounded memoization cache.
 * Arguments must be serializable; nsIURI objects are converted to their spec string before caching.
 * @param {Function} aFunc - The function to memoize.
 * @param {number} [aLimit=3000] - Maximum number of results to keep in the cache before evicting the oldest.
 * @returns {Function} A new function that returns cached results for previously-seen argument sets.
 */
function memoize(aFunc, aLimit) {
  aLimit = aLimit || LIMIT_DEF;
  var cache = Object.create(null);
  var keylist = [];

  return function (a) {
    var args = Array.prototype.slice.call(arguments);

    args.forEach(function (aVal, aIndex) {
      if (aVal instanceof Ci.nsIURI) {
        // See #1874.
        args[aIndex] = aVal.spec;
      }
    });

    let key = uneval(args);
    if (key in cache) {
      return cache[key];
    }

    let result = aFunc.apply(null, arguments);

    cache[key] = result;

    if (keylist.push(key) > aLimit) {
      delete cache[keylist.shift()];
    }

    return result;
  };
}
