/**
 * @file inArray.js
 * @overview Tests whether a value exists in an array, with optional
 * case-insensitive comparison for string arrays.
 */

const EXPORTED_SYMBOLS = ["inArray"];


/**
 * Tests whether aVal is present in aArr.
 * @param {Array} aArr - The array to search.
 * @param {*} aVal - The value to look for.
 * @param {boolean} [aCaseInsensitive] - If true, compares string elements case-insensitively.
 * @returns {boolean} True if aVal is found in aArr, false otherwise.
 */
function inArray(aArr, aVal, aCaseInsensitive) {
  if ("includes" in Array.prototype) {
    if (aCaseInsensitive) {
      aArr = aArr.map(function (aItem) {
        return aItem.toLowerCase();
      });
      aVal = aVal.toLowerCase();
    }

    return aArr.includes(aVal);
  } else {
    for (let i = 0, iLen = aArr.length; i < iLen; i++) {
      let val = aArr[i];
      if (aCaseInsensitive) {
        aVal = aVal.toLowerCase();
        val = val.toLowerCase();
      }
      if (aVal === val) {
        return true;
      }
    }

    return false;
  }
}
