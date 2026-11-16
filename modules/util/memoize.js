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
// The memoized function may have any number of arguments.  Only calls
// with primitive (or nsIURI) arguments are cached; see memoize() below.

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
 *
 * Only calls whose arguments are all primitives (or nsIURIs, keyed by
 * their spec) are cached; any other object is passed through uncached.
 * uneval() of an object from another compartment, such as a URL object a
 * script gave GM_xmlhttpRequest, gives "({})": every such call shared one
 * key, so they all got the first call's result.
 *
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

    let cacheable = true;
    args.forEach(function (aVal, aIndex) {
      if (aVal instanceof Ci.nsIURI) {
        // See #1874.
        args[aIndex] = aVal.spec;
      } else if ((aVal !== null) && ((typeof aVal == "object")
          || (typeof aVal == "function"))) {
        cacheable = false;
      }
    });
    if (!cacheable) {
      return aFunc.apply(null, arguments);
    }

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
