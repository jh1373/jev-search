import { Modal, Setting } from 'obsidian';
import { ENDPOINTS, PRICE_PER_MTOK, utf8ByteLength } from '../core/jev';
import { modelName } from '../settings';
import type JevSearch from '../main';

export class ConsentModal extends Modal {
  private done = false;
  private remember = false;
  private finish: (approved: boolean, remember: boolean) => void;

  constructor(
    private plugin: JevSearch,
    private body: string,
    finish: (approved: boolean, remember: boolean) => void,
  ) {
    super(plugin.app);
    this.finish = finish;
  }

  onOpen(): void {
    const target = this.plugin.settings.endpoint;
    this.titleEl.setText('外部送信を確認 / Confirm transmission');

    this.contentEl.createEl('p', {
      text: `宛先: ${ENDPOINTS[target].host} | Model: ${modelName(target)}`,
    });

    if (target === 'gateway') {
      this.contentEl.createEl('p', {
        text: 'Vercel AI Gateway を経由して TypeSafe AI に転送されます。保持・学習の条件はGatewayと提供元の方針に従い、当プラグインは保証しません。',
      });
    }
    if (target === 'openrouter') {
      this.contentEl.createEl('p', {
        text: 'OpenRouter を経由して TypeSafe AI に転送されます。プロバイダを TypeSafe に固定し、ZDR（ゼロデータ保持）を要求しています。保持・学習の最終条件は OpenRouter と提供元の方針に従い、当プラグインは保証しません。',
      });
    }

    this.contentEl.createEl('p', {
      text: 'クエリ・タイトル・抜粋を送信します。短いノートは全文を含みます。以下が送信するJSON全体です。取消しても送信済みデータは回収できません。',
    });

    const bytes = utf8ByteLength(this.body);
    const estCost = ((bytes * PRICE_PER_MTOK[target]) / 1e6).toFixed(6);
    this.contentEl.createEl('p', {
      text: `${bytes} bytes · 概算 $${estCost}（課金上限ではありません）`,
    });

    this.contentEl.createEl('pre', { text: this.body, cls: 'jev-preview' });

    new Setting(this.contentEl)
      .setName('Obsidianを閉じるまで次回から確認しない / Skip preview until Obsidian closes')
      .setDesc(
        'Obsidianを終了するか設定を変更するまで、確認ダイアログを省略します / Suppress confirmation until Obsidian closes or settings change.',
      )
      .addToggle(t =>
        t.setValue(this.remember).onChange(v => {
          this.remember = v;
        }),
      );

    new Setting(this.contentEl)
      .addButton(b =>
        b.setButtonText('キャンセル / Cancel').onClick(() => this.close()),
      )
      .addButton(b =>
        b
          .setButtonText('送信 / Send')
          .setCta()
          .onClick(() => {
            this.done = true;
            this.finish(true, this.remember);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) this.finish(false, false);
  }
}
