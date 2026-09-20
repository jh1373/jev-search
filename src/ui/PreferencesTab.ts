import {
  PluginSettingTab,
  Setting,
  SecretComponent,
  Notice,
  type App,
} from 'obsidian';
import { ENDPOINTS, prepare, evaluate } from '../core/jev';
import { asTarget, asSecretId, costText } from '../settings';
import { ConsentModal } from './ConsentModal';
import type JevSearch from '../main';

export class PreferencesTab extends PluginSettingTab {
  plugin: JevSearch;

  constructor(app: App, plugin: JevSearch) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    const p = this.plugin;

    this.containerEl.createEl('p', {
      text: 'Experimental preview. API keys are safely isolated in Obsidian SecretStorage (never written to data.json) or temporary session memory. / キーはこのVaultの SecretStorage（data.jsonには入りません）またはセッションメモリで安全に保持します。',
    });

    new Setting(this.containerEl)
      .setName('Enable Jev / Jevを有効化')
      .addToggle(t =>
        t.setValue(p.settings.enabled).onChange(async value => {
          p.settings.enabled = value;
          await p.save();
        }),
      );

    new Setting(this.containerEl)
      .setName('Confirm before transmission / プレビューを表示')
      .setDesc(
        'Show preview modal with payload and estimated cost before sending. If disabled, requests send immediately without prompt. / 外部送信前にモーダルで内容と概算費用を確認します。',
      )
      .addToggle(t =>
        t.setValue(p.settings.confirmTransmission).onChange(async value => {
          p.settings.confirmTransmission = value;
          p.sessionSkipConsent = false;
          await p.persist();
        }),
      );

    new Setting(this.containerEl)
      .setName('Endpoint / 接続先')
      .setDesc(
        'Select API provider: OpenRouter (recommended) or TypeSafe API direct. Arbitrary URLs are not supported. / 送信先プロバイダを選択（OpenRouter推奨、またはTypeSafe直接）。',
      )
      .addDropdown(d =>
        d
          .addOption('openrouter', 'OpenRouter')
          .addOption('direct', 'TypeSafe API (direct)')
          .addOption('gateway', 'Vercel AI Gateway')
          .setValue(p.settings.endpoint)
          .onChange(async value => {
            p.invalidate();
            p.settings.endpoint = asTarget(value);
            await p.save();
          }),
      );

    new Setting(this.containerEl)
      .setName('Stored secret / 保存するキー')
      .setDesc(
        `Secret name stored in Obsidian SecretStorage for ${ENDPOINTS[p.settings.endpoint].host}. Survives restarts; value never touches disk. / ${ENDPOINTS[p.settings.endpoint].host} 用の安全な保存キー名。再起動しても残ります。`,
      )
      .addComponent(el =>
        new SecretComponent(this.app, el)
          .setValue(p.secretName)
          .onChange(async value => {
            p.invalidate();
            p.secretName = asSecretId(value);
            await p.persist();
          }),
      );

    new Setting(this.containerEl)
      .setName('Session-only key / セッションのみのキー')
      .setDesc(
        'In-memory only; cleared when Obsidian exits. Overrides the stored secret above. / メモリ保持のみ。再起動で破棄されます。',
      )
      .addText(t => {
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'off';
        t.setPlaceholder(p.keys[p.settings.endpoint] ? '(set)' : '(empty)');
        t.onChange(value => {
          p.invalidate();
          p.key = value.trim();
        });
      });

    new Setting(this.containerEl)
      .setName('Excluded folders / 除外フォルダ')
      .setDesc(
        'One vault-relative folder per line (e.g. Templates, Confidential). / 1行に1フォルダ（例: Templates, Confidential）。',
      )
      .addTextArea(t =>
        t.setValue(p.settings.folders.join('\n')).onChange(async value => {
          const folders = value
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
          if (
            folders.some(
              s => s.includes('..') || s.startsWith('/') || s.includes(':'),
            )
          ) {
            new Notice('Invalid folder path');
            return;
          }
          p.settings.folders = folders.slice(0, 100);
          await p.save();
        }),
      );

    new Setting(this.containerEl)
      .setName('Excluded tags / 除外タグ')
      .setDesc(
        'One tag per line without hash (e.g. private, secret). / 1行に1タグ（#なし、例: private, secret）。',
      )
      .addTextArea(t =>
        t.setValue(p.settings.tags.join('\n')).onChange(async value => {
          p.settings.tags = value
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .slice(0, 100);
          await p.save();
        }),
      );

    new Setting(this.containerEl)
      .setName('Copy diagnostics / 診断をコピー')
      .setDesc(
        'Versions and counts only. No note paths, contents, queries or keys are included. / バージョンと統計数のみ。ノート本文やキーは含みません。',
      )
      .addButton(b =>
        b.setButtonText('Copy').onClick(async () => {
          const text = JSON.stringify(p.diagnostics(), null, 2);
          try {
            await navigator.clipboard.writeText(text);
            new Notice('Diagnostics copied / 診断をコピーしました');
          } catch {
            new Notice('Copy failed / コピー失敗');
          }
        }),
      );

    new Setting(this.containerEl)
      .setName('Cache TTL / キャッシュ保持')
      .setDesc(
        'Avoid redundant requests for identical queries (minutes, 0 to disable, default 30). In-memory only. / 同一クエリの再送信防止（分、0で無効、既定30）。',
      )
      .addText(t => {
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.inputEl.max = '60';
        t.setValue(String(p.settings.cacheTtlMinutes));
        t.onChange(async value => {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 60) return;
          p.settings.cacheTtlMinutes = n;
          await p.save();
        });
      });

    new Setting(this.containerEl)
      .setName('Rebuild index / 索引を再構築')
      .setDesc(
        'Rebuild the local search index from scratch. / ローカル検索インデックスを再構築します。',
      )
      .addButton(b => b.setButtonText('Rebuild').onClick(() => void p.rebuild()));

    new Setting(this.containerEl)
      .setName('Test connection / 合成データで接続確認')
      .setDesc(
        'Send a single synthetic request to verify API connectivity. / 1件の合成リクエストを送信してAPI疎通を確認します。',
      )
      .addButton(b =>
        b.setButtonText('Preview test').onClick(async () => {
          if (!p.key || p.busy) {
            new Notice('API key required / request in progress');
            return;
          }
          const prepared = prepare(
            'What day is the regular meeting?',
            [
              {
                title: 'Sample Team',
                heading: 'Meeting',
                text: 'The regular meeting is every Tuesday.',
              },
            ],
            p.settings.endpoint,
          );
          const generation = p.generation;
          const approved = await new Promise<boolean>(resolve =>
            new ConsentModal(p, prepared.body, result => resolve(result)).open(),
          );
          if (!approved || p.busy || !p.loaded || p.generation !== generation)
            return;

          p.busy = true;
          p.controller = new AbortController();
          try {
            const r = await evaluate(
              prepared.body,
              1,
              p.key,
              p.controller.signal,
              p.settings.endpoint,
              p.transport,
            );
            if (p.loaded) {
              new Notice(
                `API OK (${ENDPOINTS[p.settings.endpoint].host}): score ${r.scores[0]} / 2 · ${costText(r, p.settings.endpoint)}`,
              );
            }
          } catch {
            if (p.loaded) {
              new Notice(
                'Connection test failed. Please check your API key and network.',
              );
            }
          } finally {
            p.busy = false;
            p.controller = null;
          }
        }),
      );
  }
}

export { PreferencesTab as Preferences };
