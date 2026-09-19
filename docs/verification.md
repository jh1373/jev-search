# 検証記録 — 設計版0.2

## 実施結果

- verify-design.ps1: PASS。README・docs/design 9冊・評価プロトコル・レビュー記録の計12文書について、15要件の受入表への対応、ローカルリンク、コードフェンス、文字化けを検査。
- 公開API/モデル/Obsidian配布資料を確認。出典は設計書08。
- Node/npm/GitとObsidian実行ファイルの存在を確認。
- OPENROUTER_API_KEY / TYPESAFE_API_KEY / AI_GATEWAY_API_KEY は、このハーネスのプロセスenvには未設定（値を出力していない）。
  ユーザーはOpenRouterキーを発行済み。開発・検証の第一経路は OpenRouter、TypeSafe直接を第2、Vercel AI Gatewayを第3とする（ADR-012）。
  実API送信は未実施。
- npm run buildはpackage.json未作成のため失敗。tscコマンドも未導入。
  これは設計納品段階であり、ビルドや製品テスト成功とは報告しない。

## 試作と環境への影響

途中で `.sandbox/vault/.obsidian/plugins/jev-search-smoke` にローカル通知だけの
JavaScript試作を作成した。これはビルド済み製品でもJev連携実装でもない。
専用user-data-dirとデバッグポートでObsidianを起動したが、プラグイン読込成功は未確認。
自分で起動したプロセスを終了してデバッグ接続を閉じた。
既存個人Vaultにプラグインを配置せず、ノート内容は読み取っていない。
API送信、依存インストール、GitHub公開、Git初期コミットは行っていない。
.sandboxは.gitignoreで除外している。

## 納品範囲

正本: README、docs/design内9冊、docs/benchmark/protocol.md。
補助: scripts/verify-design.ps1、この検証記録。
旧稿: docs/archive/design-0.1。旧稿の同意/型/再試行仕様は採用しない。
次の工程はG0（専用Vaultでの最小実装・実機・合成APIテスト）。

## 追記（実装フェーズ）

本文書は設計段階の検査記録です。実装・実機GUI E2Eの結果は
[開発プレビュー記録](implementation-preview.md) を参照してください。
実機GUI E2Eは `npm run test:gui` で起動〜終了まで自動実行します。
Jev実API送信は2026-09-19にOpenRouter経由で1回実施し成功しました（合成データ、実コスト$0.000016、詳細は設計書08と開発プレビュー記録）。AT-07 は `npm run test:live`（`RUN_LIVE_TESTS=1` とenvキーの2条件を追加で要求）で、
ユーザーの端末から合成データ1送信として実行します。キーはチャット・リポジトリ・記録文書へ書きません。
