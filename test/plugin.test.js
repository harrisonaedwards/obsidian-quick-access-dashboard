"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { after, before, describe, it } = require("node:test");

class FakePlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.savedSettings = null;
  }

  async saveData(data) {
    this.savedSettings = data;
  }
}

class FakeItemView {}
class FakeModal {}
class FakeFile {}
class FakeFolder {}

const originalLoad = Module._load;
const originalWindow = global.window;
let QuickAccessPlugin;

before(() => {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        ItemView: FakeItemView,
        Keymap: { isModEvent: () => false },
        Menu: class {},
        Modal: FakeModal,
        Notice: class {},
        Plugin: FakePlugin,
        setIcon: () => {},
        TFile: FakeFile,
        TFolder: FakeFolder
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  global.window = {
    clearTimeout,
    setTimeout
  };
  QuickAccessPlugin = require("../main");
});

after(() => {
  Module._load = originalLoad;
  global.window = originalWindow;
});

function makeApp() {
  const local = new Map();
  return {
    loadLocalStorage(key) {
      return local.get(key) ?? null;
    },
    local,
    saveLocalStorage(key, value) {
      local.set(key, value);
    },
    workspace: {
      getLeavesOfType() {
        return [];
      }
    }
  };
}

describe("plugin persistence", () => {
  it("stores activity locally without pins", () => {
    const app = makeApp();
    const plugin = new QuickAccessPlugin(app, { id: "quick-access-dashboard" });
    plugin.data = {
      schemaVersion: 1,
      pins: [{ path: "Pinned.md", kind: "file" }],
      recentPaths: ["Recent.md"],
      records: {
        "Recent.md": {
          total: 1,
          lastOpenedAt: 100,
          daily: { "2026-08-16": 1 }
        }
      }
    };
    plugin.activitySaveDirty = true;

    plugin.flushActivitySave();

    const stored = app.local.get("quick-access-dashboard:activity");
    assert.deepEqual(Object.keys(stored).sort(), ["recentPaths", "records", "schemaVersion"]);
    assert.equal("pins" in stored, false);
    assert.deepEqual(plugin.loadActivityData(), stored);
  });

  it("stores pins in plugin settings without activity", async () => {
    const plugin = new QuickAccessPlugin(makeApp(), { id: "quick-access-dashboard" });
    plugin.data.pins = [{ path: "Pinned.md", kind: "file" }];
    plugin.data.recentPaths = ["Recent.md"];

    await plugin.requestSettingsSave();

    assert.deepEqual(plugin.savedSettings, {
      schemaVersion: 1,
      pins: [{ path: "Pinned.md", kind: "file" }]
    });
    assert.equal("recentPaths" in plugin.savedSettings, false);
  });

  it("resets local activity while preserving pins", () => {
    const app = makeApp();
    const plugin = new QuickAccessPlugin(app, { id: "quick-access-dashboard" });
    plugin.data.pins = [{ path: "Pinned.md", kind: "file" }];
    plugin.data.recentPaths = ["Recent.md"];
    plugin.data.records["Recent.md"] = {
      total: 1,
      lastOpenedAt: 100,
      daily: { "2026-08-16": 1 }
    };

    plugin.resetActivity();

    assert.deepEqual(plugin.data.pins, [{ path: "Pinned.md", kind: "file" }]);
    assert.deepEqual(plugin.data.recentPaths, []);
    assert.deepEqual(Object.keys(plugin.data.records), []);
    const stored = app.local.get("quick-access-dashboard:activity");
    assert.equal(stored.schemaVersion, 1);
    assert.deepEqual(stored.recentPaths, []);
    assert.deepEqual(Object.keys(stored.records), []);
  });
});
