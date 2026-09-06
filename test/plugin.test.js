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
class FakePluginSettingTab {}
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
        PluginSettingTab: FakePluginSettingTab,
        Setting: class {},
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
    assert.deepEqual(Object.keys(stored).sort(), [
      "createdPaths",
      "recentPaths",
      "records",
      "schemaVersion"
    ]);
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
      pins: [{ path: "Pinned.md", kind: "file" }],
      display: {
        limit: 12,
        sections: { recent: true, created: true, sevenDays: true, allTime: true }
      }
    });
    assert.equal("recentPaths" in plugin.savedSettings, false);
  });

  it("saves display changes as merged, clamped settings", async () => {
    const plugin = new QuickAccessPlugin(makeApp(), { id: "quick-access-dashboard" });

    await plugin.updateDisplay({ sections: { created: false } });
    await plugin.updateDisplay({ limit: 500 });

    assert.deepEqual(plugin.savedSettings.display, {
      limit: 50,
      sections: { recent: true, created: false, sevenDays: true, allTime: true }
    });
  });

  it("records file creations only after layout is ready, never folders or excluded paths", () => {
    let renders = 0;
    const app = makeApp();
    const plugin = new QuickAccessPlugin(app, { id: "quick-access-dashboard" });
    plugin.refreshViews = () => (renders += 1);
    plugin.scheduleActivitySave = () => {
      plugin.activitySaveDirty = true;
      plugin.flushActivitySave();
    };
    const file = Object.assign(new FakeFile(), { path: "New note.md" });

    plugin.handleCreate(file);
    assert.deepEqual(plugin.data.createdPaths, []);

    plugin.layoutReady = true;
    plugin.handleCreate(Object.assign(new FakeFolder(), { path: "Folder" }));
    app.vault = { getConfig: () => ["Archive/"] };
    plugin.handleCreate(Object.assign(new FakeFile(), { path: "Archive/Generated.md" }));
    plugin.handleCreate(file);

    assert.deepEqual(plugin.data.createdPaths, ["New note.md"]);
    assert.equal(renders, 1);
    assert.deepEqual(app.local.get("quick-access-dashboard:activity").createdPaths, ["New note.md"]);
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
