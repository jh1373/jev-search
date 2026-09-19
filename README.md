# Jev Search — 開発計画と詳細設計

更新日: 2026-09-18 / 設計版: 0.2 / 状態: 実装開始用設計案

## 現在の成果物

本リポジトリは**開発プレビュー実装段階**です。ローカル検索・同意付きJev再ランキングのコードとビルド生成物があります。一般配布用の安定版ではありません。
最新の実装範囲・検証結果・設計との差分は [開発プレビュー記録](docs/implementation-preview.md) を参照してください。既存の個人Vaultは変更していません。

製品名「Jev Search」、ID `jev-search` は仮称です。公開前に名前の重複・商標を確認します。
TypeSafe/Obsidianの公式製品とは表示しません。

## 読む順序

1. [なぜ Jev × Obsidian なのか](docs/design/00-why-jev-obsidian.md) ← まずこれを読む
2. [製品要件・アーキテクチャ](docs/design/01-architecture.md)
3. [Jev通信・実行時検証・キャッシュ](docs/design/02-jev-client.md)
4. [日本語検索・インデックス・再ランキング](docs/design/03-search-rerank.md)
5. [UI・外部送信同意・秘密情報](docs/design/04-ui-privacy.md)
6. [テスト・配布・運用](docs/design/05-testing-release.md)
7. [段階計画・設計判断・リスク](docs/design/06-roadmap.md)
8. [要件と受入テストの対応表](docs/design/07-acceptance.md)
9. [出典・確認済み事項・保留事項](docs/design/08-evidence.md)
10. [日本語評価プロトコル](docs/benchmark/protocol.md)
11. [レビュー記録・改善バックログ（2026-09-18）](docs/reviews/2026-09-18-product-tradeoffs.md)
12. [受入テストの実施状況（何が実測で確かめられ、何が未確認か）](docs/acceptance-status.md)
13. [公開コーパスでの再測定（日本語Wikipedia・実文書）](docs/benchmark/result-public-corpus.md)
14. [プライバシー（何が端末外に出て、何が残るか）](docs/privacy.md)

受入テスト20件のうち、実測で合格したのは **11件**（AT-01 / AT-03 / AT-04 / AT-06 / AT-08 / AT-10 / AT-12 / AT-15 / AT-17 / AT-18 / AT-20）、
一部合格が8件、未実施が AT-13 の1件です。
レビュー5項目のうち RV-04（キー再入力）は解決し、RV-02（候補漏れ）は合成コーパスと公開コーパスで数値を得ました。
未実施の AT-13 は、公開コーパスでのローカル段再測定まで済んでいます（残りはJev投入後のnDCGで、実APIキーが必要）。
詳細と残作業は [受入テストの実施状況](docs/acceptance-status.md) にあります。

## 主要な決定

- CLI、Python、独立サーバーをユーザーに要求しないObsidianネイティブUI。
- 初版はデスクトップ対応、Markdownの読み取り専用検索。モバイル対応とは表示しない。
- APIキーなしでローカル検索可能。Jevは明示的に有効化し、送信ごとに内容を確認。
- Jevは再ランキング担当。意味検索、回答生成、ノート編集は初版の対象外。
- 送信先はコード固定で、任意URLは設定できない。**一般ユーザーへの提供は OpenRouter と TypeSafe API 直接の2経路**。
  開発・検証の第一経路は **OpenRouter（既定）**、TypeSafe直接を第2、Vercel AI Gatewayを第3とする（ADR-012）。
  Gateway は応答に解決済みモデル版を返さず版照合ができないため、品質検証の主経路には使わない。
- キーは「セッション上書き」→「Obsidian SecretStorage」の順で解決する。`data.json` には秘密の**名前**だけを入れ、
  値は入れない。Obsidianを再起動しても残る（ADR-013）。保存先の実装・同期範囲は未確認のため、暗号化や非同期を宣伝しない。
- 除外処理はインデックス投入前と送信直前の二段階。未評価候補を誤って消さない。
- 初版ではJevのスコアで候補を削除しない。関連度順にするだけ。
- 価格・モデル・SDKの公開情報は保証ではない。実APIとObsidian内で検証してから出荷。

## 開発環境の確認結果

| 項目 | 確認内容 |
|---|---|
| 作業場所 | ローカルにクローンした作業ツリー（絶対パスはリポジトリに記録しない） |
| Obsidian実行ファイル | 既定のインストール先を自動検出。`OBSIDIAN_EXE` で上書きできる |
| Node / npm / Git | 24.18.0 / 11.15.0 / 2.52.0.windows.1 |
| npm公開版の照会 | obsidian 1.13.1 / typescript 7.0.2 / esbuild 0.28.2 / vitest 5.0.1 |
| APIキー | TypeSafe直接キーは未取得（待機リスト中）。**OpenRouter のキーは発行済み**。開発は OpenRouter 経由で進める（ADR-012） |
| 既存Vault | Obsidian設定から所在のみ確認。テスト対象にはしない |

npm版の照会は互換性検証ではありません。依存の採用・固定はG0で実ビルド後に行います。
OSのNodeとObsidian内のElectron/Chromiumは別環境です。

## 次の実装工程

G0: 合成ノートだけを使う接続スパイク → G1: ローカル検索 → G2: 同意付きJev連携
→ G3: 公開可能な日本語評価 → G4: 非開発者ベータ → G5: 公開。
各工程の完了条件は設計書06・07を参照してください。

秘密情報をチャット・README・Gitへ貼り付けないでください。
実APIテストは明示的なコマンド、専用の合成データ、回数制限を満たす場合だけ実施します。

## テスト

```
npm run check        # 型検査 → 単体35件 → ビルド
npm run test:bundle  # 生成バンドルの読込・ローカル検索
npm run test:release # 版一致・LICENSE/NOTICE・秘密/個人パスの混入検査
npm run test:gui     # 実機Obsidian GUI E2E（専用Vault・起動〜終了・証跡）
npm run test:mock    # 実APIキーなしでJev応答の扱いを検証（制御したトランスポート）
```

`test:gui`は専用Vault以外では実行を拒否し、今回起動したプロセスだけを終了します。
証跡（スクリーンショット・report/summary）は `.sandbox/gui-e2e/evidence/` に保存します。
個人Vaultと実APIは使用しません。詳細と未検証範囲は
[開発プレビュー記録](docs/implementation-preview.md) を参照してください。

## 設計検査

`scripts/verify-design.ps1` は
文書の存在、ローカルリンク、要件ID参照、文字化けを機械検査します。
これはプラグイン動作・API・セキュリティ監査を代替しません。
