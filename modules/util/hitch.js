/**
 * @file hitch.js
 * @overview Binds a method to an object and optionally pre-fills leading
 * arguments, returning a new bound function (similar to Function.prototype.bind).
 */

const EXPORTED_SYMBOLS = ["hitch"];


/**
 * Binds a method to an object with optional pre-filled leading arguments.
 * @param {object} aObj - The object to use as "this"; may be null when aMethod is a function.
 * @param {string|Function} aMethod - Method name on aObj, or a function to bind directly.
 * @param {...*} [staticArgs] - Zero or more arguments prepended to every call of the returned function.
 * @returns {Function} A new function that calls aMethod on aObj with the bound arguments prepended.
 * @throws {string} If aMethod is a string that does not exist on aObj, or if arguments are otherwise invalid.
 */
function hitch(aObj, aMethod) {
  if (aObj && aMethod && (typeof aMethod == "string")) {
    if (!aObj[aMethod]) {
      throw 'GM_util.hitch: Method "' + aMethod
          + '" does not exist on object:' + "\n" + aObj;
    }
    aMethod = aObj[aMethod];
  } else if (typeof aMethod == "function") {
    aObj = aObj || {};
  } else {
    throw "GM_util.hitch: Invalid arguments.";
  }

  var staticArgs = Array.prototype.splice.call(arguments, 2, arguments.length);

  return function () {
    // Make a copy of staticArgs
    // (don't modify it because it gets reused for every invocation).
    let args = Array.prototype.slice.call(staticArgs);

    // Add all the new arguments.
    Array.prototype.push.apply(args, arguments);

    // Invoke the original function with the correct this obj
    // and the combined list of static and dynamic arguments.
    return aMethod.apply(aObj, args);
  };
}
