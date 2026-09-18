# 01. 製品要件・アーキテクチャ

設計版0.2 / 2026-09-18 / 実装開始用。旧版はアーカイブであり実装根拠にしない。

## 製品の約束

一般ユーザーがObsidian内で設定・検索・抜粋確認を完結できる。
CLI、Python、別サーバー、GPUは不要。初版はデスクトップ限定、Windowsを先行検証。
macOS/Linuxは確認後に対応を表示する。名前とIDは仮称。

## 要件

| ID | 要件 |
|---|---|
| F-01 | APIキーなし・オフラインでもローカル検索 |
| F-02 | 日英混在Markdownの見出し単位検索・原文移動 |
| F-03 | 明示同意した候補のみJevで再ランキング |
| F-04 | ローカル順/Jev順切替、障害・未評価を区別 |
| F-05 | 除外、送信量、概算費用の制御 |
| F-06 | クエリ/Vault/設定変更後に古い結果を適用しない |
| F-07 | 合成データ限定・回数制限付き接続テスト |
| S-01 | キー・本文・クエリをログ/Git/テレメトリに出さない |
| S-02 | 除外・同意・送信先を通信直前に検証 |
| S-03 | 外部応答を実行時検証、ノート内の指示を実行しない |
| S-04 | ノートの作成・編集・削除・移動を行わない |
| N-01 | ローカル結果を先に表示、UIを長時間ブロックしない |
| N-02 | 索引を増分更新、無効化時に資源解放 |
| N-03 | 公開データによる性能再評価 |
| N-04 | 配布物の版・依存・ライセンスを追跡 |

非対象: 回答生成、ノート編集、画像/PDF解析、ベクトル検索、MCP、全Vault送信。
BM25は語彙検索。候補に入らない同義語文書をJevが発見できるとは主張しない。

## 論理構成

Obsidian adapter → 除外ポリシー → local index/search → candidate snapshot
→ payload builder → consent gate → Jev transport → validator → results → UI

| モジュール | 責務 |
|---|---|
| main / adapters/obsidian | Plugin、Vault/MetadataCacheイベント、requestUrl、位置移動 |
| core/index | 正規化・チャンク・転置索引・BM25・増分更新 |
| core/policy | フォルダ/タグ除外、送信許可、プライバシー世代 |
| core/pipeline | 検索世代、取消、スナップショット、結果統合 |
| core/jev | ペイロード、応答検証、リトライ、使用量 |
| core/cache | 内容ハッシュ付きメモリLRU、失効 |
| ui | ItemView、Modal、PluginSettingTab、日英文言、キーボード操作 |
| adapters/secrets | セッション内キー、検証済み保存先への委譲 |

依存はUI/adapters → core。coreはObsidian/Node/Electronをimportしない。
Transport、Clock、Scheduler、Digest、NoteSourceを注入する。
requestUrlの物理取消が不可能なら取消を偽装しない（02参照）。

## 境界型（実装時の契約）

```ts
type Chunk = {
  id: string; path: string; title: string; heading: string;
  startLine: number; endLine: number; text: string; contentHash: string;
};
type Candidate = { chunk: Chunk; localRank: number; localScore: number };
type SearchSnapshot = {
  queryId: number; indexGeneration: number; policyGeneration: number;
  query: string; candidates: readonly Candidate[];
};
type ResultMode = 'local' | 'reranked' | 'fallback' | 'partial';
```

pathはローカル識別専用。外部は匿名ID・タイトル・見出し・抜粋・クエリのみ。
タイトルにも個人情報があり得るため必ずプレビュー対象とする。

## 構成・依存方針

予定構成: src/main.ts、src/core/{index,policy,pipeline,jev,cache}、
src/adapters/{obsidian,secrets}、src/ui、test/{unit,integration,fixtures}、scripts。
main.jsにバンドルしobsidianをexternalとする。ネイティブ拡張/CLIは不要。
TypeScript/esbuild/Vitestが候補。最新版の照会は互換性検証ではない。
「依存ゼロ」より、監査可能性・保守性・サイズを重視。新依存はADRとlockfileで固定。

## 非機能目標（実測前）

G0でCPU/RAM/OS/Obsidian/Electron版を記録。
- 合成10,000ノート、合計50MiBを評価上限。
- 温まった索引の検索p95 ≤300ms、初期索引 ≤30秒。
- メインスレッド処理を8ms程度で分割しyieldする。
- 索引/保持本文/キャッシュの管理対象合計 ≤150MiB（JS全ヒープ保証ではない）。
- Jev対話待ち時間は合計4秒。物理通信は別管理。
未達なら対応規模を下げて表示するか、索引を改善する。無言の切捨ては禁止。
