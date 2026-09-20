import {
  Plugin,
  TFile,
  getAllTags,
  Notice,
  requestUrl,
} from 'obsidian';
import { SearchIndex, isExcluded } from './core/search';
import { type Target, type Transport } from './core/jev';
import { createRequestUrlTransport } from './adapters/transport';
import { JudgementCache } from './core/cache';
import {
  VIEW,
  YIELD_BUDGET_MS,
  DEFAULT,
  asTarget,
  asTtl,
  asSecretId,
  type Settings,
} from './settings';
import { SearchView } from './ui/SearchView';
import { PreferencesTab } from './ui/PreferencesTab';

export default class JevSearch extends Plugin {
  index = new SearchIndex();
  settings: Settings = { ...DEFAULT };
  keys: Record<Target, string> = { openrouter: '', direct: '', gateway: '' };
  generation = 0;
  loaded = true;
  busy = false;

  /** Injected network transport. Defaults to Obsidian's official requestUrl adapter. */
  transport: Transport = createRequestUrlTransport(params =>
    ((globalThis as any).requestUrl ?? requestUrl)(params),
  );

  /** In-memory session toggle: skip transmission preview modal until Obsidian unloads or settings change. */
  sessionSkipConsent = false;

  /** Session override for the current destination; cleared on unload. */
  set key(value: string) {
    this.keys[this.settings.endpoint] = value;
  }

  get secretName(): string {
    return this.settings.secrets[this.settings.endpoint];
  }

  set secretName(value: string) {
    this.settings.secrets[this.settings.endpoint] = value;
  }

  /**
   * Resolve the session override first, then the vault-keyed SecretStorage entry.
   * The secret value is never written to data.json; only its name is stored there.
   */
  get key(): string {
    const session = this.keys[this.settings.endpoint];
    if (session) return session;
    const name = this.settings.secrets[this.settings.endpoint];
    if (!name) return '';
    try {
      return this.app.secretStorage.getSecret(name) ?? '';
    } catch {
      return '';
    }
  }

  controller: AbortController | null = null;
  skipped = 0;
  indexed = false;

  private updates = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private saves: Promise<void> = Promise.resolve();
  private yielded = 0;
  private pending = new Set<string>();
  private stamp = 0;
  cache = new JudgementCache(DEFAULT.cacheTtlMinutes);

  async onload(): Promise<void> {
    const raw = await this.loadData();
    if (raw && typeof raw === 'object') {
      this.settings = {
        folders: this.list(raw.folders, DEFAULT.folders),
        tags: this.list(raw.tags, DEFAULT.tags),
        enabled: raw.enabled === true,
        endpoint: asTarget(raw.endpoint),
        secrets: this.secrets(raw.secrets),
        cacheTtlMinutes: asTtl(raw.cacheTtlMinutes),
        confirmTransmission: raw.confirmTransmission !== false,
      };
    }
    this.syncCache();

    this.registerView(VIEW, leaf => new SearchView(leaf, this));
    this.addRibbonIcon('search', 'Jev Search', () => void this.open());
    this.addCommand({
      id: 'open-search',
      name: 'Open search',
      callback: () => void this.open(),
    });
    this.addSettingTab(new PreferencesTab(this.app, this));

    const changed = (file: TFile): void => {
      this.index.remove(file.path);
      this.invalidate();
      this.schedule(file);
    };

    this.registerEvent(
      this.app.vault.on('modify', f => {
        if (f instanceof TFile) changed(f);
      }),
    );
    this.registerEvent(
      this.app.vault.on('create', f => {
        if (f instanceof TFile) changed(f);
      }),
    );
    // Dropping the entry both invalidates a queued schedule for this path and keeps the map bounded.
    this.registerEvent(
      this.app.vault.on('delete', f => {
        this.updates.delete(f.path);
        this.index.remove(f.path);
        this.invalidate();
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, old) => {
        this.updates.delete(old);
        this.invalidate();
        this.index.remove(old);
        if (f instanceof TFile) this.schedule(f);
      }),
    );
    this.registerEvent(this.app.metadataCache.on('changed', f => changed(f)));

    if (this.app.workspace.layoutReady) {
      if (this.loaded) void this.rebuild();
    } else {
      this.app.workspace.onLayoutReady(() => {
        if (this.loaded) void this.rebuild();
      });
    }
  }

  list(v: unknown, fallback: string[]): string[] {
    return Array.isArray(v) &&
      v.length <= 100 &&
      v.every(x => typeof x === 'string' && x.length <= 256)
      ? v
      : [...fallback];
  }

  /** Sanitize stored secret names. A value can never round-trip through here. */
  secrets(v: unknown): Record<Target, string> {
    const source =
      v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
    return {
      openrouter: asSecretId(source.openrouter),
      direct: asSecretId(source.direct),
      gateway: asSecretId(source.gateway),
    };
  }

  invalidate(): void {
    this.generation++;
    this.controller?.abort();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
      if (leaf.view instanceof SearchView) {
        leaf.view.invalidate();
        leaf.view.search();
      }
    }
  }

  eligible(file: TFile): boolean {
    return (
      file.extension === 'md' &&
      file.stat.size <= 1048576 &&
      !isExcluded(
        file.path,
        [],
        this.settings.folders,
        [],
        this.app.vault.configDir,
      )
    );
  }

  allowed(file: TFile): boolean {
    const metadata = this.app.metadataCache.getFileCache(file);
    return (
      this.eligible(file) &&
      !!metadata &&
      !isExcluded(
        file.path,
        getAllTags(metadata) ?? [],
        this.settings.folders,
        this.settings.tags,
        this.app.vault.configDir,
      )
    );
  }

  // Stamps come from one global counter, so a deleted and recreated path can never reuse a stamp.
  schedule(file: TFile): void {
    const stamp = ++this.stamp;
    this.updates.set(file.path, stamp);
    this.queue = this.queue
      .then(async () => {
        if (!this.loaded || this.updates.get(file.path) !== stamp) return;
        this.index.remove(file.path);
        if (!this.allowed(file)) {
          // An eligible note with no metadata cache entry yet is retried once the cache catches up.
          if (
            this.eligible(file) &&
            !this.app.metadataCache.getFileCache(file)
          ) {
            this.pending.add(file.path);
          } else {
            this.pending.delete(file.path);
          }
          return;
        }
        this.pending.delete(file.path);
        const mtime = file.stat.mtime;
        const text = await this.app.vault.cachedRead(file);
        if (
          !this.loaded ||
          file.stat.mtime !== mtime ||
          this.updates.get(file.path) !== stamp ||
          !this.allowed(file)
        ) {
          return;
        }
        this.index.upsert({
          path: file.path,
          title: file.basename,
          text,
          tags: [],
        });
        // A timer after every note costs more than the indexing it protects, so yield on a time budget.
        const now = performance.now();
        if (now - this.yielded >= YIELD_BUDGET_MS) {
          this.yielded = now;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      })
      .catch(() => {
        if (this.loaded) new Notice('Jev Search: a note could not be indexed.');
      });
  }

  async rebuild(): Promise<void> {
    this.invalidate();
    this.index.clear();
    this.skipped = 0;
    this.indexed = false;
    this.yielded = 0;
    this.pending.clear();

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.stat.size > 1048576) this.skipped++;
      this.schedule(file);
    }
    await this.queue;

    // Reporting ready while eligible notes are still missing would be wrong, so retry the notes whose
    // metadata cache entry had not resolved yet before flipping the flag.
    for (let pass = 0; pass < 80 && this.loaded && this.pending.size; pass++) {
      const retry = [...this.pending];
      await new Promise(resolve => setTimeout(resolve, 250));
      for (const path of retry) {
        const file = this.app.vault.getFileByPath(path);
        if (file) this.schedule(file);
      }
      await this.queue;
    }
    if (this.loaded) {
      this.indexed = true;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) {
        if (leaf.view instanceof SearchView) leaf.view.search();
      }
    }
  }

  async open(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf =
        this.app.workspace.getRightLeaf(false) ??
        this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async persist(): Promise<void> {
    const snapshot = structuredClone(this.settings);
    this.saves = this.saves
      .then(() => this.saveData(snapshot))
      .catch(() => {
        if (this.loaded) new Notice('Settings could not be saved');
      });
    await this.saves;
  }

  /** The cache follows the configured TTL; changing a setting drops every entry it holds. */
  syncCache(): void {
    this.cache = new JudgementCache(this.settings.cacheTtlMinutes);
  }

  /** Counts and versions only. No path, note text, query or key can reach this object. */
  diagnostics(): Record<string, unknown> {
    return {
      pluginVersion: this.manifest?.version ?? '',
      minAppVersion: this.manifest?.minAppVersion ?? '',
      notes: this.index.size,
      indexed: this.indexed,
      oversizedSkipped: this.skipped,
      endpoint: this.settings.endpoint,
      enabled: this.settings.enabled,
      confirmTransmission: this.settings.confirmTransmission,
      sessionSkipConsent: this.sessionSkipConsent,
      excludedFolders: this.settings.folders.length,
      excludedTags: this.settings.tags.length,
      cacheEntries: this.cache.size,
      cacheTtlMinutes: this.settings.cacheTtlMinutes,
    };
  }

  async save(): Promise<void> {
    this.sessionSkipConsent = false;
    this.index.clear();
    this.invalidate();
    this.syncCache();
    await this.persist();
    await this.rebuild();
  }

  onunload(): void {
    this.loaded = false;
    this.sessionSkipConsent = false;
    this.invalidate();
    this.keys = { openrouter: '', direct: '', gateway: '' };
    this.index.clear();
    this.pending.clear();
    this.cache.clear();
  }
}
