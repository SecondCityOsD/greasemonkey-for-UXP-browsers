/**
 * @file importDialog.js
 * @overview Drives the selective backup-import dialog (importDialog.xul).
 *
 * Flow: onLoad runs GM_BackupPreview on the chosen archive and renders one
 * checkbox row per script (pre-checked, disabled when the entry can't
 * import).  Accept runs GM_BackupImport with the selection and the three
 * toggles (overwrite / restore values / restore settings); the dialog
 * stays open showing progress, then reports the summary — including the
 * pre-import safety snapshot path — and closes.
 *
 * All strings come from gmAddons.properties when the active locale has
 * them, with inline English fallbacks otherwise (missing .properties keys
 * are non-fatal, unlike DTD entities).
 */

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/backup.js");


var GM_ImportDialog = {
  "_bundle": null,
  "_file": null,
  "_running": false,

  /**
   * Localized string with English fallback; %1/%2/%3 placeholders are
   * replaced from aArgs in order.
   */
  "s": function (aKey, aFallback, aArgs) {
    let text = null;
    try {
      if (!this._bundle) {
        this._bundle = Cc["@mozilla.org/intl/stringbundle;1"]
            .getService(Ci.nsIStringBundleService)
            .createBundle("chrome://greasemonkey/locale/gmAddons.properties");
      }
      text = this._bundle.GetStringFromName(aKey);
    } catch (e) {
      text = aFallback;
    }
    if (aArgs) {
      for (let i = 0; i < aArgs.length; i++) {
        text = text.split("%" + (i + 1)).join("" + aArgs[i]);
      }
    }
    return text;
  },

  "onLoad": function () {
    this._file = window.arguments[0].file;

    document.documentElement.setAttribute("title",
        this.s("backup.import.windowTitle", "Import user scripts backup"));
    document.documentElement.getButton("accept").label =
        this.s("backup.import.importButton", "Import");
    document.getElementById("gm-import-select-all").setAttribute("label",
        this.s("backup.import.selectAll", "Select all"));
    document.getElementById("gm-import-overwrite").setAttribute("label",
        this.s("backup.import.overwrite",
            "Overwrite scripts that are already installed"));
    document.getElementById("gm-import-values").setAttribute("label",
        this.s("backup.import.values",
            "Restore stored script values from the backup"));
    document.getElementById("gm-import-settings").setAttribute("label",
        this.s("backup.import.settings",
            "Restore global Greasemonkey settings from the backup"));

    let preview = GM_BackupPreview(this._file);

    let heading = document.getElementById("gm-import-heading");
    heading.value = this.s("backup.import.heading",
        "%1 - %2 script(s) found",
        [this._file.leafName, preview.scripts.length]);

    if (!preview.ok) {
      this._setStatus(this.s("backup.import.cannotImport",
          "Cannot import: %1", [preview.error || ""]));
      document.documentElement.getButton("accept").disabled = true;
      return;
    }

    this._populate(preview);

    let settingsBox = document.getElementById("gm-import-settings");
    settingsBox.disabled = !preview.hasSettings;
    settingsBox.checked = preview.hasSettings;

    if (preview.warnings.length) {
      this._setStatus(preview.warnings.join("; "));
    }
  },

  "_populate": function (aPreview) {
    let list = document.getElementById("gm-import-list");
    for (let i = 0; i < aPreview.scripts.length; i++) {
      let row = aPreview.scripts[i];
      let item = document.createElement("richlistitem");
      let box = document.createElement("checkbox");

      let label = (row.name || row.key)
          + (row.version ? " " + row.version : "");
      let notes = [];
      if (row.error) {
        notes.push(this.s("backup.import.cannotImport",
            "Cannot import: %1", [row.error]));
      } else {
        if (row.installed) {
          notes.push(this.s("backup.import.installed", "already installed"));
        }
        if (row.hasStorage) {
          notes.push(this.s("backup.import.hasValues", "stored values"));
        }
        if (row.depCount) {
          notes.push(this.s("backup.import.deps",
              "%1 archived dependencies", [row.depCount]));
        }
      }
      if (notes.length) {
        label += " — " + notes.join(" · ");
      }

      box.setAttribute("label", label);
      box.setAttribute("crop", "end");
      box.setAttribute("flex", "1");
      if (row.error) {
        box.setAttribute("disabled", "true");
        box.setAttribute("checked", "false");
      } else {
        box.setAttribute("checked", "true");
      }
      box._gmKey = row.key;
      box._gmImportable = !row.error;

      item.appendChild(box);
      list.appendChild(item);
    }
  },

  "_boxes": function () {
    let out = [];
    let list = document.getElementById("gm-import-list");
    for (let i = 0; i < list.itemCount; i++) {
      let box = list.getItemAtIndex(i).firstChild;
      if (box && box._gmImportable) {
        out.push(box);
      }
    }
    return out;
  },

  "toggleAll": function () {
    let state = document.getElementById("gm-import-select-all").checked;
    let boxes = this._boxes();
    for (let i = 0; i < boxes.length; i++) {
      boxes[i].checked = state;
    }
  },

  "_setStatus": function (aText) {
    let status = document.getElementById("gm-import-status");
    status.value = aText;
    status.setAttribute("tooltiptext", aText);
  },

  "onAccept": function () {
    if (this._running) {
      return false;
    }

    let selected = [];
    let boxes = this._boxes();
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) {
        selected.push(boxes[i]._gmKey);
      }
    }

    let restoreSettings =
        document.getElementById("gm-import-settings").checked;
    if (!selected.length && !restoreSettings) {
      this._setStatus(
          this.s("backup.import.nothingSelected", "Nothing selected."));
      return false;
    }

    this._running = true;
    document.documentElement.getButton("accept").disabled = true;

    let self = this;
    let options = {
      "selectedKeys": selected,
      "overwrite": document.getElementById("gm-import-overwrite").checked,
      "restoreValues": document.getElementById("gm-import-values").checked,
      "restoreSettings": restoreSettings,
      "onProgress": function (aDone, aTotal, aKey) {
        self._setStatus(self.s("backup.import.progress",
            "Importing %1 of %2 - %3", [aDone + 1, aTotal, aKey]));
      },
    };

    GM_BackupImport(this._file, options, function (aOk, aResult, aErr) {
      let message;
      if (aOk) {
        message = self.s("backup.imported",
            "Import complete.\n\nInstalled: %1\nSkipped: %2",
            [aResult.imported, aResult.skipped]);
        if (aResult.errors && aResult.errors.length) {
          message += "\n\n" + aResult.errors.join("\n");
        }
        if (aResult.snapshotPath) {
          message += "\n\n" + self.s("backup.import.snapshotLine",
              "Safety snapshot: %1", [aResult.snapshotPath]);
        }
      } else {
        message = self.s("backup.failed",
            "Backup operation failed.\n\n%1", [aErr || ""]);
      }
      alert(message);
      window.close();
    });

    // Keep the dialog open; the completion callback closes it.
    return false;
  },
};
