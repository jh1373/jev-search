import { ItemView, Setting, Notice, type WorkspaceLeaf } from 'obsidian';
import { type SearchHit } from '../core/search';
import { prepare, evaluate } from '../core/jev';
import { judgementKey } from '../core/cache';
import { VIEW, costText } from '../settings';
import { ConsentModal } from './ConsentModal';
import type JevSearch from '../main';

export class SearchView extends ItemView {
  input!: HTMLInputElement;
  results!: HTMLElement;
  status!: HTMLElement;
  local: SearchHit[] = [];
  epoch = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  composing = false;
  plugin: JevSearch;

  constructor(leaf: WorkspaceLeaf, plugin: JevSearch) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW;
  }

  getDisplayText(): string {
    return 'Jev Search';
  }

  getIcon(): string {
    return 'search';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('jev-search');

    this.input = root.createEl('input', {
      type: 'search',
      placeholder: 'ノートを検索 / Search notes',
      attr: { 'aria-label': 'Search notes' },
    });

    // An IME fires input events while the reading is still being converted, so a search scheduled then
    // would run against half-composed text and flicker the results. Wait for compositionend instead.
    this.registerDomEvent(this.input, 'input', () => {
      this.invalidate();
      if (this.timer) clearTimeout(this.timer);
      if (this.composing) return;
      this.timer = setTimeout(() => this.search(), 150);
    });

    this.registerDomEvent(this.input, 'compositionstart', () => {
      this.composing = true;
      if (this.timer) clearTimeout(this.timer);
    });

    this.registerDomEvent(this.input, 'compositionend', () => {
      this.composing = false;
      this.search();
    });

    new Setting(root)
      .addButton(b =>
        b.setButtonText('Local order / ローカル順').onClick(() => this.search()),
      )
      .addButton(b =>
        b
          .setButtonText('Rerank with Jev / Jevで並べ替え')
          .onClick(() => void this.rerank()),
      )
      .addButton(b =>
        b.setButtonText('Cancel / 取消').onClick(() => {
          this.plugin.controller?.abort();
          this.invalidate();
        }),
      );

    this.status = root.createDiv({
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.results = root.createDiv();
    this.search();
  }

  invalidate(): void {
    this.epoch++;
    this.plugin.controller?.abort();
    if (this.status) {
      this.status.setText(
        'Results invalidated. Please search again. / 更新されました。再検索してください。',
      );
    }
  }

  search(): void {
    if (!this.input) return;
    this.local = this.plugin.index.search(this.input.value, 50);
    this.render(this.local);
    this.status.setText(
      `${this.plugin.index.size} notes · ${this.local.length} chunks · ${this.plugin.indexed ? 'Ready' : 'Indexing'} · oversized skipped: ${this.plugin.skipped}`,
    );
  }

  render(hits: SearchHit[], scores?: Map<string, number>): void {
    this.results.empty();
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);

      const row = this.results.createDiv({ cls: 'jev-result' });
      const button = row.createEl('button', { text: hit.path });
      button.onclick = () => {
        const file = this.app.vault.getFileByPath(hit.path);
        if (!file) {
          new Notice('Note no longer exists');
          return;
        }
        void this.app.workspace.getLeaf(false).openFile(file, {
          eState: { line: Math.max(0, hit.startLine - 1) },
        });
      };

      row.createEl('small', { text: hit.heading });
      row.createEl('p', { text: hit.text.slice(0, 240) });
      if (scores) {
        row.createEl('small', {
          text: scores.has(hit.id)
            ? `Jev relevance: ${scores.get(hit.id)!.toFixed(2)} / 2 (not correctness probability)`
            : '未評価 / Not evaluated',
        });
      }
    }
  }

  async rerank(): Promise<void> {
    const p = this.plugin;
    if (!p.settings.enabled || !p.key) {
      new Notice(
        'Please enable Jev in settings and configure an API key. / 設定でJevを有効化し、APIキーを入力してください。',
      );
      return;
    }
    if (p.busy) {
      new Notice('Request in progress / 通信中です');
      return;
    }

    this.search();
    const query = this.input.value;
    const generation = p.generation;
    const epoch = this.epoch;
    const hits = this.local.slice(0, 20);
    if (!hits.length) return;

    const prepared = prepare(query, hits, p.settings.endpoint);
    const shouldConfirm =
      p.settings.confirmTransmission !== false && !p.sessionSkipConsent;

    if (shouldConfirm) {
      const result = await new Promise<{ approved: boolean; remember: boolean }>(
        resolve =>
          new ConsentModal(p, prepared.body, (approved, remember) =>
            resolve({ approved, remember }),
          ).open(),
      );
      if (
        !result.approved ||
        !p.loaded ||
        epoch !== this.epoch ||
        generation !== p.generation ||
        p.busy
      ) {
        return;
      }
      if (result.remember) p.sessionSkipConsent = true;
    } else {
      if (
        !p.loaded ||
        epoch !== this.epoch ||
        generation !== p.generation ||
        p.busy
      ) {
        return;
      }
    }

    for (const hit of hits.slice(0, prepared.count)) {
      const f = this.app.vault.getFileByPath(hit.path);
      if (!f || !p.allowed(f)) {
        new Notice(
          'Content modified. Please search again. / 対象が変更されました。再検索してください。',
        );
        return;
      }
    }

    p.busy = true;
    const controller = new AbortController();
    p.controller = controller;
    this.status.setText('Sending to Jev… / Jevへ送信中…');

    try {
      // The body is content-addressed, so an edited note or a changed exclusion cannot hit a stale entry.
      const cacheKey = await judgementKey(
        prepared.body,
        p.settings.endpoint,
        p.key,
      );
      const hit = p.cache.get(cacheKey);
      const fromCache = hit !== null;
      const r =
        hit ??
        (await evaluate(
          prepared.body,
          prepared.count,
          p.key,
          controller.signal,
          p.settings.endpoint,
          p.transport,
        ));
      if (!fromCache) p.cache.set(cacheKey, r);
      if (!p.loaded || generation !== p.generation || epoch !== this.epoch)
        return;

      const scores = new Map(
        hits.slice(0, prepared.count).map((h, i) => [h.id, r.scores[i]]),
      );
      const ranked = hits
        .slice(0, prepared.count)
        .sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
      const allLow = r.scores.every(s => s < 1);
      this.render(
        allLow ? this.local : [...ranked, ...this.local.slice(prepared.count)],
        scores,
      );
      this.status.setText(
        `${allLow ? 'Low relevance, local order retained / 関連度が低いため元順を保持' : 'Jev ranked'} · ${prepared.count} chunks · ${fromCache ? 'cache hit · no new charge' : `input tokens: ${r.inputTokens ?? 'unknown'} · ${costText(r, p.settings.endpoint)}`}`,
      );
    } catch (error) {
      if (p.loaded && generation === p.generation && epoch === this.epoch) {
        this.render(this.local);
        this.status.setText(
          `Local fallback: ${error instanceof Error ? error.message : 'failed'}`,
        );
      }
    } finally {
      p.busy = false;
      if (p.controller === controller) p.controller = null;
    }
  }

  async onClose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.invalidate();
    this.contentEl.empty();
  }
}
