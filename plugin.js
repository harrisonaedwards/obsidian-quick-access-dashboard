const {
  ItemView,
  Keymap,
  Menu,
  Modal,
  Notice,
  Plugin,
  setIcon,
  TFile,
  TFolder
} = require("obsidian");

const VIEW_TYPE = "quick-access-dashboard-view";
const MENU_SOURCE = "quick-access-dashboard";
const DISPLAY_LIMIT = 12;
const ACTIVITY_STORAGE_KEY = "quick-access-dashboard:activity";
const ACTIVITY_SAVE_DELAY_MS = 750;

class ResetActivityModal extends Modal {
  constructor(app, onConfirm) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    this.setTitle("Reset access statistics?");
    this.setContent("This permanently deletes recent and most-opened activity on this device. Pins are kept.");

    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    actions
      .createEl("button", { text: "Cancel", attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    actions
      .createEl("button", { cls: "mod-warning", text: "Reset", attr: { type: "button" } })
      .addEventListener("click", () => {
        this.close();
        this.onConfirm();
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class QuickAccessView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expandedFolders = new Set();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Quick Access";
  }

  getIcon() {
    return "pin";
  }

  async onOpen() {
    this.contentEl.addClass("quick-access-dashboard");
    this.render();
  }

  onPaneMenu(menu) {
    menu.addItem((item) =>
      item
        .setTitle("Close")
        .setIcon("x")
        .onClick(() => this.app.workspace.detachLeavesOfType(VIEW_TYPE))
    );
  }

  render() {
    this.contentEl.empty();
    this.renderPinnedSection();
    this.renderRecentSection();
    this.renderRankedSection("Most opened · 7 days", rankSevenDays(this.plugin.data, new Date()));
    this.renderRankedSection("Most opened · all time", rankAllTime(this.plugin.data));
  }

  renderPinnedSection() {
    const body = this.createSection("Pinned");
    const existingPins = this.plugin.data.pins
      .map((pin) => ({ pin, target: this.app.vault.getAbstractFileByPath(pin.path) }))
      .filter((entry) => entry.target !== null);

    if (existingPins.length === 0) {
      this.renderEmpty(body, "Right-click a file or folder to pin it.");
      return;
    }

    for (const { target } of existingPins) {
      if (target instanceof TFolder) {
        this.renderFolder(target, body, true);
      } else if (target instanceof TFile) {
        this.renderFile(target, body, { removable: true });
      }
    }
  }

  renderRecentSection() {
    const body = this.createSection("Recent");
    const files = this.plugin.data.recentPaths
      .map((path) => this.app.vault.getFileByPath(path))
      .filter((file) => file !== null)
      .slice(0, DISPLAY_LIMIT);

    if (files.length === 0) {
      this.renderEmpty(body, "Files appear here as you navigate.");
      return;
    }

    for (const file of files) {
      this.renderFile(file, body);
    }
  }

  renderRankedSection(title, ranked) {
    const body = this.createSection(title);
    const existing = ranked
      .map((entry) => ({ entry, file: this.app.vault.getFileByPath(entry.path) }))
      .filter((value) => value.file !== null)
      .slice(0, DISPLAY_LIMIT);

    if (existing.length === 0) {
      this.renderEmpty(body, "Counts begin with your next file change.");
      return;
    }

    for (const { entry, file } of existing) {
      this.renderFile(file, body, { count: entry.count });
    }
  }

  createSection(title) {
    const section = this.contentEl.createDiv({ cls: "quick-access-section" });
    section.createEl("h3", { cls: "quick-access-heading", text: title });
    return section.createDiv({ cls: "quick-access-list" });
  }

  renderEmpty(container, message) {
    container.createDiv({ cls: "quick-access-empty", text: message });
  }

  renderFile(file, container, options = {}) {
    const row = container.createDiv({ cls: "quick-access-row quick-access-file" });
    const target = row.createEl("button", {
      attr: { title: file.path, type: "button" },
      cls: "quick-access-target"
    });

    const icon = target.createSpan({ cls: "quick-access-icon" });
    setIcon(icon, file.extension === "md" ? "file-text" : "file");

    const labels = target.createDiv({ cls: "quick-access-labels" });
    labels.createDiv({
      cls: "quick-access-name",
      text: file.extension === "md" ? file.basename : file.name
    });
    if (file.parent && file.parent.path !== "/") {
      labels.createDiv({ cls: "quick-access-path", text: file.parent.path });
    }

    if (options.count !== undefined) {
      target.createSpan({ cls: "quick-access-count", text: String(options.count) });
    }
    if (options.removable) {
      this.addUnpinButton(row, file.path, "file");
    }

    target.addEventListener("click", (event) => {
      void this.plugin.openFile(file, Boolean(Keymap.isModEvent(event)));
    });
    target.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void this.plugin.openFile(file, true);
      }
    });
    this.addContextMenu(target, file);
  }

  renderFolder(folder, container, removable) {
    const expanded = this.expandedFolders.has(folder.path);
    const group = container.createDiv({ cls: "quick-access-folder-group" });
    const row = group.createDiv({ cls: "quick-access-row quick-access-folder" });
    const target = row.createEl("button", {
      attr: { "aria-expanded": String(expanded), title: folder.path, type: "button" },
      cls: "quick-access-target"
    });

    const icon = target.createSpan({ cls: "quick-access-icon" });
    setIcon(icon, expanded ? "chevron-down" : "chevron-right");

    const labels = target.createDiv({ cls: "quick-access-labels" });
    labels.createDiv({ cls: "quick-access-name", text: folder.name });
    const parentPath = folder.parent?.path;
    if (parentPath && parentPath !== "/") {
      labels.createDiv({ cls: "quick-access-path", text: parentPath });
    }
    if (removable) {
      this.addUnpinButton(row, folder.path, "folder");
    }

    target.addEventListener("click", () => {
      if (expanded) {
        this.expandedFolders.delete(folder.path);
      } else {
        this.expandedFolders.add(folder.path);
      }
      this.render();
    });
    this.addContextMenu(target, folder);

    if (!expanded) {
      return;
    }

    const children = [...folder.children].sort((left, right) => {
      if (left instanceof TFolder && right instanceof TFile) {
        return -1;
      }
      if (left instanceof TFile && right instanceof TFolder) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    });

    const childContainer = group.createDiv({ cls: "quick-access-folder-children" });
    if (children.length === 0) {
      const empty = childContainer.createDiv({ cls: "quick-access-empty" });
      empty.setText("Empty folder");
      return;
    }

    for (const child of children) {
      if (child instanceof TFolder) {
        this.renderFolder(child, childContainer, false);
      } else if (child instanceof TFile) {
        this.renderFile(child, childContainer);
      }
    }
  }

  addUnpinButton(row, path, kind) {
    const button = row.createEl("button", {
      attr: { "aria-label": "Unpin", title: "Unpin" },
      cls: "clickable-icon quick-access-unpin"
    });
    setIcon(button, "x");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.plugin.setPinned(path, kind, false);
    });
  }

  addContextMenu(row, target) {
    row.addEventListener("contextmenu", (event) => {
      const menu = new Menu();
      this.app.workspace.trigger("file-menu", menu, target, MENU_SOURCE);
      menu.showAtMouseEvent(event);
    });
  }
}

class QuickAccessPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.data = emptyData();
    this.settingsSaveInFlight = null;
    this.settingsSaveDirty = false;
    this.activitySaveTimer = null;
    this.activitySaveDirty = false;
    this.layoutReady = false;
    this.trackingReady = false;
    this.trackingStartTimer = null;
    this.activePath = null;
  }

  async onload() {
    const settings = await this.loadData();
    const activity = this.loadActivityData();
    const needsMigration = activity === null;
    this.data = combineStoredData(settings, activity ?? settings);
    const pruned = pruneDailyData(this.data, new Date());

    this.registerView(VIEW_TYPE, (leaf) => new QuickAccessView(leaf, this));
    this.addRibbonIcon("pin", "Open Quick Access", () => void this.openDashboard(true));
    this.addCommand({
      id: "open-dashboard",
      name: "Open dashboard",
      callback: () => void this.openDashboard(true)
    });
    this.addCommand({
      id: "toggle-pin-active-file",
      name: "Pin or unpin active file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.togglePinned(file);
        }
        return true;
      }
    });
    this.addCommand({
      id: "reset-access-statistics",
      name: "Reset access statistics",
      callback: () => {
        new ResetActivityModal(this.app, () => this.resetActivity()).open();
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => this.addPinMenuItem(menu, target))
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.observeForegroundFile(file))
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () =>
        this.observeForegroundFile(this.app.workspace.getActiveFile())
      )
    );
    this.registerEvent(
      this.app.vault.on("rename", (target, oldPath) => this.handleRename(target, oldPath))
    );
    this.registerEvent(this.app.vault.on("delete", (target) => this.handleDelete(target)));

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
      this.scheduleTrackingStart();
    });

    this.register(() => {
      if (this.trackingStartTimer !== null) {
        window.clearTimeout(this.trackingStartTimer);
      }
      if (this.activitySaveTimer !== null) {
        window.clearTimeout(this.activitySaveTimer);
      }
    });

    if (pruned || needsMigration) {
      this.scheduleActivitySave();
    }
  }

  onunload() {
    this.layoutReady = false;
    this.trackingReady = false;
    if (this.trackingStartTimer !== null) {
      window.clearTimeout(this.trackingStartTimer);
      this.trackingStartTimer = null;
    }
    this.flushActivitySave();
  }

  onUserEnable() {
    this.app.workspace.onLayoutReady(() => void this.openDashboard(true));
  }

  async openFile(file, newTab) {
    await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  async setPinned(path, kind, pinned) {
    const exists = this.data.pins.some((pin) => pin.path === path && pin.kind === kind);
    if (pinned && !exists) {
      this.data.pins.push({ path, kind });
    } else if (!pinned && exists) {
      this.data.pins = this.data.pins.filter((pin) => pin.path !== path || pin.kind !== kind);
    } else {
      return;
    }

    this.refreshViews();
    await this.requestSettingsSave();
  }

  async togglePinned(target) {
    const kind = target instanceof TFolder ? "folder" : "file";
    const pinned = this.data.pins.some((pin) => pin.path === target.path && pin.kind === kind);
    await this.setPinned(target.path, kind, !pinned);
  }

  addPinMenuItem(menu, target) {
    if (!(target instanceof TFile) && !(target instanceof TFolder)) {
      return;
    }

    const kind = target instanceof TFolder ? "folder" : "file";
    const pinned = this.data.pins.some((pin) => pin.path === target.path && pin.kind === kind);
    menu.addItem((item) =>
      item
        .setSection("action")
        .setTitle(pinned ? "Unpin from Quick Access" : "Pin to Quick Access")
        .setIcon(pinned ? "pin-off" : "pin")
        .onClick(() => void this.setPinned(target.path, kind, !pinned))
    );
  }

  observeForegroundFile(file) {
    if (!this.trackingReady) {
      this.activePath = file?.path ?? null;
      if (this.layoutReady) {
        this.scheduleTrackingStart();
      }
      return;
    }

    const path = file?.path ?? null;
    if (path === this.activePath) {
      return;
    }
    this.activePath = path;

    if (!path) {
      return;
    }

    recordAccess(this.data, path, new Date());
    this.refreshViews();
    this.scheduleActivitySave();
  }

  scheduleTrackingStart() {
    if (!this.layoutReady) {
      return;
    }
    if (this.trackingStartTimer !== null) {
      window.clearTimeout(this.trackingStartTimer);
    }
    this.trackingStartTimer = window.setTimeout(() => {
      this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
      this.trackingReady = true;
      this.trackingStartTimer = null;
    }, 500);
  }

  handleRename(target, oldPath) {
    const folder = target instanceof TFolder;
    if (!renamePath(this.data, oldPath, target.path, folder)) {
      return;
    }

    const activePath = this.activePath;
    if (activePath !== null && (activePath === oldPath || (folder && activePath.startsWith(`${oldPath}/`)))) {
      this.activePath = `${target.path}${activePath.slice(oldPath.length)}`;
    }
    this.refreshViews();
    void this.requestSettingsSave();
    this.scheduleActivitySave();
  }

  handleDelete(target) {
    const folder = target instanceof TFolder;
    if (!deletePath(this.data, target.path, folder)) {
      return;
    }

    if (
      this.activePath === target.path ||
      (folder && this.activePath?.startsWith(`${target.path}/`))
    ) {
      this.activePath = null;
    }
    this.refreshViews();
    void this.requestSettingsSave();
    this.scheduleActivitySave();
  }

  async openDashboard(reveal) {
    try {
      await this.app.workspace.ensureSideLeaf(VIEW_TYPE, "left", { reveal });
    } catch (error) {
      console.error("Quick Access: could not open the sidebar", error);
      if (reveal) {
        new Notice("Could not open Quick Access");
      }
    }
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof QuickAccessView) {
        leaf.view.render();
      }
    }
  }

  loadActivityData() {
    return this.app.loadLocalStorage(ACTIVITY_STORAGE_KEY);
  }

  resetActivity() {
    clearActivityData(this.data);
    this.activitySaveDirty = true;
    this.flushActivitySave();
    this.refreshViews();
    new Notice("Access statistics reset");
  }

  scheduleActivitySave() {
    this.activitySaveDirty = true;
    if (this.activitySaveTimer !== null) {
      return;
    }
    this.activitySaveTimer = window.setTimeout(() => {
      this.activitySaveTimer = null;
      this.flushActivitySave();
    }, ACTIVITY_SAVE_DELAY_MS);
  }

  flushActivitySave() {
    if (this.activitySaveTimer !== null) {
      window.clearTimeout(this.activitySaveTimer);
      this.activitySaveTimer = null;
    }
    if (!this.activitySaveDirty) {
      return;
    }
    try {
      this.app.saveLocalStorage(ACTIVITY_STORAGE_KEY, activitySnapshot(this.data));
      this.activitySaveDirty = false;
    } catch (error) {
      console.error("Quick Access: could not save local activity data", error);
    }
  }

  requestSettingsSave() {
    this.settingsSaveDirty = true;
    if (this.settingsSaveInFlight === null) {
      this.settingsSaveInFlight = this.drainSettingsSaves().finally(() => {
        this.settingsSaveInFlight = null;
        if (this.settingsSaveDirty) {
          void this.requestSettingsSave();
        }
      });
    }
    return this.settingsSaveInFlight;
  }

  async drainSettingsSaves() {
    while (this.settingsSaveDirty) {
      this.settingsSaveDirty = false;
      try {
        await this.saveData(settingsSnapshot(this.data));
      } catch (error) {
        this.settingsSaveDirty = false;
        console.error("Quick Access: could not save pinned items", error);
        return;
      }
    }
  }
}

module.exports = QuickAccessPlugin;
