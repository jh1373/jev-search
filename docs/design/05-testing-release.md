# 05. 検証・配布・運用設計

本書のコマンドの一部は未実装。実装済みは `npm run typecheck` / `test` / `test:live` / `build` / `test:bundle` / `test:gui` / `verify`。

## テスト層

1. core単体: Vitest、Clock/Transport/Digestを注入し完全オフライン。
2. adapter結合: Obsidianモックに加え専用Vaultで実アプリ検証。
3. 実API: 明示的な `npm run test:live`(`scripts/smoke-live.mjs`) と `RUN_LIVE_TESTS=1` とenvキーの3条件。
   キーは `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` / `AI_GATEWAY_API_KEY` のいずれかをプロセスenvから読む。
   合成データだけ、最大3送信（スクリプトは1送信）、最大推定$0.01。通常testから呼ばない。
   キーはファイルへ書かず、出力にも含めない。混入していればスクリプトが失敗する。
4. 評価: [日本語プロトコル](../benchmark/protocol.md)に沿い品質/速度/費用を測定。
5. 非開発者ベータ: APIキー取得後から初回検索まで自力で完了できるか観察。

## テストケース

- tokenizer: NFKC、半角カナ、漢字、長音、単一文字、ASCII単語、絵文字、空文字。
- chunk: 重複見出し、コードフェンス、frontmatter、長段落、行番号、改行コード。
- BM25: 手計算した小コーパスとの一致、削除後df/avgdl、同点順、空索引。
- policy: folder境界、本文タグ、未確定metadata、除外変更→承認/キャッシュ失効。
- transport: 200、401、403、413、422、429、529、ネットワーク断、4秒期限、遅着。
  Retry-Afterは整数秒とHTTP日付。ミリ秒として解釈しない。
- response: scoreは0〜2、probabilities/confidenceは0〜1。NaN、欠損ID、異種回答、
  巨大応答、JSON破損、モデル違いを拒否。意味的正しさはスキーマ検査で保証しない。
- pipeline: 承認payload hash一致、入力更新競合、削除/改名、アンロード後応答。
- concurrency: 物理通信1本、取消済み通信が終わるまで次を開始しない。
- cache: TTL/LRU/byte上限、キー/モデル/ポリシー変更、失敗非保存、usage二重加算なし。
- privacy: 未承認送信0回、秘密文字列がログ・data.json・診断にないこと。

テスト成功だけでなく失敗ケースを通す。live失敗を「環境問題」として無条件免除しない。
接続/契約異常は出荷ブロックとし、障害原因を記録する。

## 専用VaultとE2E

予定パス: `C:\Users\systemuser\Desktop\Jev×Obsidian\.sandbox\vault`。
個人Vault `C:\Users\systemuser\Documents\Obsidian Vault` は使用しない。
試験データは架空チームの会議など機密を含まない自作Markdown。
Obsidian実行ファイルは `C:\Users\systemuser\AppData\Local\Programs\Obsidian\Obsidian.exe`。
専用Vaultを明示して開く。既存Vault登録やプラグイン設定は上書きしない。

E2E項目: 読込→コマンド表示→検索→同意→実API→結果→位置移動→無効化。
キーなし、ネット断、ダークテーマ、IME、ズーム200%、キーボード、設定再起動も試験。
Nodeモックでのonload成功と、Obsidian実機での成功は別々に記録する。

## CIと配布

予定CI: Windows/macOS/Linuxで npm ci → typecheck → lint → unit → build → artifact検査。
Node 22/24候補の互換性をG0で確認。インストールはレジストリ通信が必要。
「テスト本体」は外部通信を禁止し、CI全体がオフラインとは記述しない。
lockfile固定、GitHub ActionsのコミットSHA固定、権限は原則contents:read。
PRから秘密情報を参照しない。リリースだけ限定的にwrite権限。

配布物: main.js、manifest.json、styles.css。versionはpackage/manifest/tagで一致。
versions.jsonには過去リリースと最低Obsidian版を記録。最低版はG0で使用APIから決定。
ライセンス一覧、依存一覧、checksums、変更履歴、プライバシー説明、日英READMEを付ける。
秘密情報/個人パス/テストVaultをアーカイブに含めない。

公式コミュニティディレクトリから申請。必要なGitHub/Obsidianアカウントの所有確認、
公開manifest、同版GitHub Releaseを用意する。審査の所要期間や通過は保証しない。

## 出荷基準と運用

セキュリティ要件は全通過。未承認送信/キー漏洩/個人ノート変更は1件でも出荷不可。
critical/high脆弱性は修正または根拠付きの影響なし判断が必要。
通信障害は無期限再試行せずローカル検索に戻す。

重大障害時: 再現用合成データ収集→対象版特定→Jev無効化案内→修正版→回帰テスト。
ユーザーにVault原本やAPIキーの添付を求めない。漏洩時はキー失効/再発行を案内。
ロールバック用の前版Releaseを保持。ただし脆弱版の再導入は勧めない。
設定の未知schemaVersionは破壊せず、ローカル検索のみ・移行案内。
