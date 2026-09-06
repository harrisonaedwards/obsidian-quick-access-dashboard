"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  activitySnapshot,
  clearActivityData,
  combineStoredData,
  compileExcludedFilters,
  deletePath,
  emptyData,
  isExcludedPath,
  localDayKeys,
  normaliseData,
  rankAllTime,
  rankSevenDays,
  recordAccess,
  recordCreate,
  renamePath,
  settingsSnapshot
} = require("../model");

describe("access aggregation", () => {
  it("counts accesses without storing raw events", () => {
    const data = emptyData();
    const first = new Date(2026, 7, 16, 9, 30);
    const second = new Date(2026, 7, 16, 10, 0);

    recordAccess(data, "Folder/Note.md", first);
    recordAccess(data, "Other.md", second);
    recordAccess(data, "Folder/Note.md", second);

    assert.equal(data.records["Folder/Note.md"].total, 2);
    assert.equal(data.records["Folder/Note.md"].daily["2026-08-16"], 2);
    assert.deepEqual(data.recentPaths, ["Folder/Note.md", "Other.md"]);
    assert.deepEqual(rankAllTime(data)[0], {
      path: "Folder/Note.md",
      count: 2,
      lastOpenedAt: second.getTime()
    });
  });

  it("uses the current local day and six preceding local calendar days", () => {
    const data = emptyData();
    const now = new Date(2026, 7, 16, 12, 0);

    recordAccess(data, "Old.md", new Date(2026, 7, 9, 12, 0));
    for (const day of [...localDayKeys(now)].reverse()) {
      const [year, month, date] = day.split("-").map(Number);
      recordAccess(data, "Week.md", new Date(year, month - 1, date, 12, 0));
    }

    assert.deepEqual(rankSevenDays(data, now), [
      { path: "Week.md", count: 7, lastOpenedAt: new Date(2026, 7, 16, 12, 0).getTime() }
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(data.records["Old.md"].daily)), {
      "2026-08-09": 1
    });
  });
});

describe("path lifecycle", () => {
  it("moves pinned, recent, and aggregate data on a folder rename", () => {
    const data = emptyData();
    data.pins = [{ path: "Old", kind: "folder" }, { path: "Old/Note.md", kind: "file" }];
    recordAccess(data, "Old/Note.md", new Date(2026, 7, 16, 12, 0));

    assert.equal(renamePath(data, "Old", "New", true), true);
    assert.deepEqual(data.pins, [
      { path: "New", kind: "folder" },
      { path: "New/Note.md", kind: "file" }
    ]);
    assert.deepEqual(data.recentPaths, ["New/Note.md"]);
    assert.equal(data.records["New/Note.md"].total, 1);
    assert.equal(data.records["Old/Note.md"], undefined);
  });

  it("removes descendants when a folder is deleted", () => {
    const data = emptyData();
    data.pins = [{ path: "Keep.md", kind: "file" }, { path: "Gone", kind: "folder" }];
    recordAccess(data, "Keep.md", new Date(2026, 7, 16, 12, 0));
    recordAccess(data, "Gone/Note.md", new Date(2026, 7, 16, 12, 0));

    assert.equal(deletePath(data, "Gone", true), true);
    assert.deepEqual(data.pins, [{ path: "Keep.md", kind: "file" }]);
    assert.deepEqual(data.recentPaths, ["Keep.md"]);
    assert.equal(data.records["Gone/Note.md"], undefined);
  });
});

describe("defensive loading", () => {
  it("drops malformed and duplicate persisted values", () => {
    const data = normaliseData({
      pins: [
        { path: "A.md", kind: "file" },
        { path: "A.md", kind: "file" },
        { path: "Bad", kind: "unknown" }
      ],
      recentPaths: ["A.md", "A.md", null],
      records: {
        "A.md": { total: 2.9, lastOpenedAt: 100.9, daily: { "2026-08-16": 1.8, bad: 5 } },
        "Bad.md": { total: -1, lastOpenedAt: "yesterday", daily: {} }
      }
    });

    assert.deepEqual(data.pins, [{ path: "A.md", kind: "file" }]);
    assert.deepEqual(data.recentPaths, ["A.md"]);
    assert.deepEqual(JSON.parse(JSON.stringify(data.records["A.md"])), {
      total: 2,
      lastOpenedAt: 100,
      daily: { "2026-08-16": 1 }
    });
    assert.equal(data.records["Bad.md"], undefined);
  });
});

describe("display settings", () => {
  it("defaults, clamps, and ignores malformed display values", () => {
    assert.deepEqual(normaliseData({ pins: [] }).display, {
      limit: 12,
      sections: { recent: true, created: true, sevenDays: true, allTime: true }
    });
    assert.equal(normaliseData({ display: { limit: 0 } }).display.limit, 1);
    assert.equal(normaliseData({ display: { limit: 99.7 } }).display.limit, 50);
    assert.equal(normaliseData({ display: { limit: "7" } }).display.limit, 12);

    const sections = normaliseData({
      display: { sections: { created: false, allTime: "no", bogus: false } }
    }).display.sections;
    assert.deepEqual(sections, { recent: true, created: false, sevenDays: true, allTime: true });
  });

  it("keeps display settings with pins in plugin settings", () => {
    const data = emptyData();
    data.display.limit = 5;
    data.display.sections.recent = false;

    const settings = settingsSnapshot(data);
    assert.deepEqual(settings.display, {
      limit: 5,
      sections: { recent: false, created: true, sevenDays: true, allTime: true }
    });
    assert.equal("display" in activitySnapshot(data), false);
    assert.deepEqual(combineStoredData(settings, activitySnapshot(data)).display, settings.display);
  });
});

describe("recently created", () => {
  it("keeps newest-first, de-duplicated, capped created paths in activity data", () => {
    const data = emptyData();
    assert.equal(recordCreate(data, ""), false);
    for (let index = 0; index < 60; index += 1) {
      recordCreate(data, `Note ${index}.md`);
    }
    recordCreate(data, "Note 58.md");

    assert.equal(data.createdPaths.length, 50);
    assert.deepEqual(data.createdPaths.slice(0, 3), ["Note 58.md", "Note 59.md", "Note 57.md"]);
    assert.equal("createdPaths" in activitySnapshot(data), true);
    assert.equal("createdPaths" in settingsSnapshot(data), false);
    assert.deepEqual(normaliseData({ createdPaths: ["A.md", "A.md", 3] }).createdPaths, ["A.md"]);
  });

  it("matches Obsidian's excluded-files rules: anchored, escaped, case-insensitive prefixes or /regex/", () => {
    const compiled = compileExcludedFilters([
      "06 Archive/OpenCairn/",
      "Notes (old)/",
      "/^Daily\\/\\d{4}/",
      "/[unclosed/",
      "",
      42
    ]);

    assert.equal(compiled.length, 3);
    assert.equal(isExcludedPath("06 Archive/OpenCairn/Session Logs/a.md", compiled), true);
    assert.equal(isExcludedPath("06 archive/opencairn/a.md", compiled), true);
    assert.equal(isExcludedPath("06 Archive/OpenCairnX/a.md", compiled), false);
    assert.equal(isExcludedPath("Other/06 Archive/OpenCairn/a.md", compiled), false);
    assert.equal(isExcludedPath("Notes (old)/a.md", compiled), true);
    assert.equal(isExcludedPath("Daily/2026-09-06.md", compiled), true);
    assert.equal(isExcludedPath("daily/2026-09-06.md", compiled), false);
    assert.equal(isExcludedPath("Inbox/a.md", compiled), false);
    assert.deepEqual(compileExcludedFilters(null), []);
  });

  it("follows renames and deletions", () => {
    const data = emptyData();
    recordCreate(data, "Untitled.md");
    recordCreate(data, "Inbox/Draft.md");

    assert.equal(renamePath(data, "Untitled.md", "Meeting notes.md", false), true);
    assert.equal(renamePath(data, "Inbox", "Archive", true), true);
    assert.deepEqual(data.createdPaths, ["Archive/Draft.md", "Meeting notes.md"]);

    assert.equal(deletePath(data, "Archive", true), true);
    assert.deepEqual(data.createdPaths, ["Meeting notes.md"]);
    assert.equal(clearActivityData(data), true);
    assert.deepEqual(data.createdPaths, []);
  });
});

describe("persistence boundaries", () => {
  it("keeps pins in plugin settings and activity in vault-local storage", () => {
    const data = emptyData();
    data.pins = [{ path: "Pinned.md", kind: "file" }];
    recordAccess(data, "Recent.md", new Date(2026, 7, 16, 12, 0));

    const settings = settingsSnapshot(data);
    const activity = activitySnapshot(data);

    assert.deepEqual(settings, {
      schemaVersion: 1,
      pins: [{ path: "Pinned.md", kind: "file" }],
      display: {
        limit: 12,
        sections: { recent: true, created: true, sevenDays: true, allTime: true }
      }
    });
    assert.deepEqual(Object.keys(activity).sort(), [
      "createdPaths",
      "recentPaths",
      "records",
      "schemaVersion"
    ]);
    assert.equal("pins" in activity, false);
    assert.equal("records" in settings, false);
    assert.deepEqual(combineStoredData(settings, activity), data);
  });

  it("can migrate activity from the original combined settings shape", () => {
    const legacy = {
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

    const migrated = combineStoredData(legacy, legacy);
    assert.deepEqual(migrated.pins, legacy.pins);
    assert.deepEqual(migrated.recentPaths, legacy.recentPaths);
    assert.equal(migrated.records["Recent.md"].total, 1);
  });

  it("resets activity without removing pins", () => {
    const data = emptyData();
    data.pins = [{ path: "Pinned.md", kind: "file" }];
    recordAccess(data, "Recent.md", new Date(2026, 7, 16, 12, 0));

    assert.equal(clearActivityData(data), true);
    assert.deepEqual(data.pins, [{ path: "Pinned.md", kind: "file" }]);
    assert.deepEqual(data.recentPaths, []);
    assert.deepEqual(Object.keys(data.records), []);
    assert.equal(clearActivityData(data), false);
  });
});
