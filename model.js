"use strict";

const SCHEMA_VERSION = 1;
const RECENT_STORAGE_LIMIT = 50;
const SEVEN_DAY_WINDOW = 7;
const DEFAULT_DISPLAY_LIMIT = 12;
const MIN_DISPLAY_LIMIT = 1;
const MAX_DISPLAY_LIMIT = RECENT_STORAGE_LIMIT;
const SECTION_KEYS = ["recent", "created", "sevenDays", "allTime"];

function emptyRecordMap() {
  return Object.create(null);
}

function defaultDisplay() {
  const sections = {};
  for (const key of SECTION_KEYS) {
    sections[key] = true;
  }
  return { limit: DEFAULT_DISPLAY_LIMIT, sections };
}

function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    pins: [],
    display: defaultDisplay(),
    recentPaths: [],
    createdPaths: [],
    records: emptyRecordMap()
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPath(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function positiveInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function displayLimit(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DISPLAY_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), MIN_DISPLAY_LIMIT), MAX_DISPLAY_LIMIT);
}

function normaliseDisplay(raw) {
  const display = defaultDisplay();
  if (!isObject(raw)) {
    return display;
  }
  display.limit = displayLimit(raw.limit);
  if (isObject(raw.sections)) {
    for (const key of SECTION_KEYS) {
      if (typeof raw.sections[key] === "boolean") {
        display.sections[key] = raw.sections[key];
      }
    }
  }
  return display;
}

function timestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function uniquePaths(paths, limit = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(paths)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const value of paths) {
    if (!isPath(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function normaliseData(raw) {
  if (!isObject(raw)) {
    return emptyData();
  }

  const data = emptyData();

  if (Array.isArray(raw.pins)) {
    const seen = new Set();
    for (const value of raw.pins) {
      if (!isObject(value) || !isPath(value.path)) {
        continue;
      }
      if (value.kind !== "file" && value.kind !== "folder") {
        continue;
      }
      const key = `${value.kind}\0${value.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      data.pins.push({ path: value.path, kind: value.kind });
    }
  }

  data.display = normaliseDisplay(raw.display);
  data.recentPaths = uniquePaths(raw.recentPaths, RECENT_STORAGE_LIMIT);
  data.createdPaths = uniquePaths(raw.createdPaths, RECENT_STORAGE_LIMIT);

  if (isObject(raw.records)) {
    for (const [path, value] of Object.entries(raw.records)) {
      if (!isPath(path) || !isObject(value)) {
        continue;
      }

      const daily = Object.create(null);
      if (isObject(value.daily)) {
        for (const [day, count] of Object.entries(value.daily)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            const safeCount = positiveInteger(count);
            if (safeCount > 0) {
              daily[day] = safeCount;
            }
          }
        }
      }

      const total = positiveInteger(value.total);
      const lastOpenedAt = timestamp(value.lastOpenedAt);
      if (total > 0 || lastOpenedAt > 0 || Object.keys(daily).length > 0) {
        data.records[path] = { total, lastOpenedAt, daily };
      }
    }
  }

  return data;
}

function cloneData(data) {
  return normaliseData(JSON.parse(JSON.stringify(data)));
}

function combineStoredData(settings, activity) {
  const safeSettings = isObject(settings) ? settings : {};
  const safeActivity = isObject(activity) ? activity : {};
  return normaliseData({
    pins: safeSettings.pins,
    display: safeSettings.display,
    recentPaths: safeActivity.recentPaths,
    createdPaths: safeActivity.createdPaths,
    records: safeActivity.records
  });
}

function settingsSnapshot(data) {
  const snapshot = cloneData(data);
  return {
    schemaVersion: snapshot.schemaVersion,
    pins: snapshot.pins,
    display: snapshot.display
  };
}

function activitySnapshot(data) {
  const snapshot = cloneData(data);
  return {
    schemaVersion: snapshot.schemaVersion,
    recentPaths: snapshot.recentPaths,
    createdPaths: snapshot.createdPaths,
    records: snapshot.records
  };
}

function clearActivityData(data) {
  const changed =
    data.recentPaths.length > 0 ||
    data.createdPaths.length > 0 ||
    Object.keys(data.records).length > 0;
  data.recentPaths = [];
  data.createdPaths = [];
  data.records = emptyRecordMap();
  return changed;
}

function pad(value) {
  return value.toString().padStart(2, "0");
}

function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDayKeys(now, days = SEVEN_DAY_WINDOW) {
  const keys = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    keys.push(localDayKey(date));
  }
  return keys;
}

function pruneDailyData(data, now) {
  const keep = new Set(localDayKeys(now));
  let changed = false;

  for (const record of Object.values(data.records)) {
    for (const day of Object.keys(record.daily)) {
      if (!keep.has(day)) {
        delete record.daily[day];
        changed = true;
      }
    }
  }
  return changed;
}

function recordAccess(data, path, now) {
  if (!isPath(path)) {
    return;
  }

  const day = localDayKey(now);
  const record = data.records[path] ?? {
    total: 0,
    lastOpenedAt: 0,
    daily: Object.create(null)
  };

  record.total = Math.min(record.total + 1, Number.MAX_SAFE_INTEGER);
  record.lastOpenedAt = now.getTime();
  record.daily[day] = Math.min((record.daily[day] ?? 0) + 1, Number.MAX_SAFE_INTEGER);
  const keep = new Set(localDayKeys(now));
  for (const candidate of Object.keys(record.daily)) {
    if (!keep.has(candidate)) {
      delete record.daily[candidate];
    }
  }
  data.records[path] = record;
  data.recentPaths = [path, ...data.recentPaths.filter((candidate) => candidate !== path)].slice(
    0,
    RECENT_STORAGE_LIMIT
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function compileExcludedFilters(filters) {
  if (!Array.isArray(filters)) {
    return [];
  }
  const compiled = [];
  for (const filter of filters) {
    if (typeof filter !== "string" || filter.length === 0) {
      continue;
    }
    const regex = /^\/(.+)\/([a-z]*)$/.exec(filter);
    try {
      compiled.push(regex ? new RegExp(regex[1], regex[2]) : new RegExp(`^${escapeRegExp(filter)}`, "i"));
    } catch {
      // Ignore filters that are not valid regular expressions.
    }
  }
  return compiled;
}

function isExcludedPath(path, compiledFilters) {
  return isPath(path) && compiledFilters.some((filter) => filter.test(path));
}

function recordCreate(data, path) {
  if (!isPath(path)) {
    return false;
  }
  data.createdPaths = [path, ...data.createdPaths.filter((candidate) => candidate !== path)].slice(
    0,
    RECENT_STORAGE_LIMIT
  );
  return true;
}

function sevenDayCount(record, now) {
  return localDayKeys(now).reduce((sum, day) => sum + (record.daily[day] ?? 0), 0);
}

function rank(data, countForRecord) {
  const ranked = [];
  for (const [path, record] of Object.entries(data.records)) {
    const count = countForRecord(record);
    if (count > 0) {
      ranked.push({ path, count, lastOpenedAt: record.lastOpenedAt });
    }
  }

  return ranked.sort(
    (left, right) =>
      right.count - left.count ||
      right.lastOpenedAt - left.lastOpenedAt ||
      left.path.localeCompare(right.path)
  );
}

function rankAllTime(data) {
  return rank(data, (record) => record.total);
}

function rankSevenDays(data, now) {
  return rank(data, (record) => sevenDayCount(record, now));
}

function remapPath(path, oldPath, newPath, folder) {
  if (path === oldPath) {
    return newPath;
  }
  if (folder && path.startsWith(`${oldPath}/`)) {
    return `${newPath}${path.slice(oldPath.length)}`;
  }
  return path;
}

function mergeRecords(left, right) {
  if (!left) {
    return right;
  }

  const daily = Object.create(null);
  for (const [day, count] of Object.entries(left.daily)) {
    daily[day] = count;
  }
  for (const [day, count] of Object.entries(right.daily)) {
    daily[day] = Math.min((daily[day] ?? 0) + count, Number.MAX_SAFE_INTEGER);
  }

  return {
    total: Math.min(left.total + right.total, Number.MAX_SAFE_INTEGER),
    lastOpenedAt: Math.max(left.lastOpenedAt, right.lastOpenedAt),
    daily
  };
}

function renamePath(data, oldPath, newPath, folder) {
  if (!isPath(oldPath) || !isPath(newPath) || oldPath === newPath) {
    return false;
  }

  let changed = false;
  const pins = data.pins.map((pin) => {
    const path = remapPath(pin.path, oldPath, newPath, folder);
    changed ||= path !== pin.path;
    return { ...pin, path };
  });
  const pinKeys = new Set();
  data.pins = pins.filter((pin) => {
    const key = `${pin.kind}\0${pin.path}`;
    if (pinKeys.has(key)) {
      changed = true;
      return false;
    }
    pinKeys.add(key);
    return true;
  });

  const remapList = (paths) =>
    uniquePaths(
      paths.map((path) => {
        const remapped = remapPath(path, oldPath, newPath, folder);
        changed ||= remapped !== path;
        return remapped;
      }),
      RECENT_STORAGE_LIMIT
    );
  data.recentPaths = remapList(data.recentPaths);
  data.createdPaths = remapList(data.createdPaths);

  const records = emptyRecordMap();
  for (const [path, record] of Object.entries(data.records)) {
    const remapped = remapPath(path, oldPath, newPath, folder);
    changed ||= remapped !== path;
    records[remapped] = mergeRecords(records[remapped], record);
  }
  data.records = records;

  return changed;
}

function matchesDeletedPath(candidate, path, folder) {
  return candidate === path || (folder && candidate.startsWith(`${path}/`));
}

function deletePath(data, path, folder) {
  if (!isPath(path)) {
    return false;
  }

  let changed = false;
  const pinCount = data.pins.length;
  data.pins = data.pins.filter((pin) => !matchesDeletedPath(pin.path, path, folder));
  changed ||= data.pins.length !== pinCount;

  for (const key of ["recentPaths", "createdPaths"]) {
    const count = data[key].length;
    data[key] = data[key].filter((candidate) => !matchesDeletedPath(candidate, path, folder));
    changed ||= data[key].length !== count;
  }

  for (const candidate of Object.keys(data.records)) {
    if (matchesDeletedPath(candidate, path, folder)) {
      delete data.records[candidate];
      changed = true;
    }
  }

  return changed;
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_DISPLAY_LIMIT,
  MAX_DISPLAY_LIMIT,
  MIN_DISPLAY_LIMIT,
  RECENT_STORAGE_LIMIT,
  SECTION_KEYS,
  SEVEN_DAY_WINDOW,
  activitySnapshot,
  clearActivityData,
  cloneData,
  combineStoredData,
  compileExcludedFilters,
  deletePath,
  emptyData,
  isExcludedPath,
  localDayKey,
  localDayKeys,
  normaliseData,
  normaliseDisplay,
  pruneDailyData,
  rankAllTime,
  rankSevenDays,
  recordAccess,
  recordCreate,
  renamePath,
  settingsSnapshot,
  sevenDayCount
};
