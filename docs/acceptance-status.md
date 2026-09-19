# 受入テストの実施状況 — 設計版0.2 / 実装0.1.0

最終更新: 2026-09-19（commit `426b6c0`）

この文書は [07. 受入テストの対応表](design/07-acceptance.md) の AT-01〜AT-20 と、
[製品レビュー](reviews/2026-09-18-product-tradeoffs.md) の RV-01〜RV-05 について、
**何が実測で確かめられ、何が確かめられていないか**を1か所に記録するものです。

`docs/design/07-acceptance.md` の「状態は全て未実施」は設計段階の記述です。実装後の状態はこの文書が正です。

## 判定の凡例

| 表記 | 意味 |
|---|---|
| 合格 | 受入条件を満たすことを実測で確認した |
| 一部合格 | 条件の一部だけを確認した。残りは下の「残作業」に書く |
| 未実施 | 手順を実行していない |
| 実施不能 | この環境では実行できない（理由を書く） |

**未実施を合格として扱いません。** 単体テストの通過を、実機の受入成功に読み替えません。

## 検証方法について

Jev連携の受入テスト（AT-03 / AT-04 / AT-06 / AT-15 / AT-17）は、`scripts/verify-at-mock.mjs` が
**`node:https.request` を制御した応答に差し替えて**実施しています。ビルド済みバンドルは
`(0, import_node_https.request)(...)` と呼び出すため、実行時にプロパティを差し替えれば送信を
横取りできます。これにより**実APIキーも実送信も使わずに**、応答の扱い・期限・取消・承認の
無効化を検証できます。

これは**プラグイン側の挙動**の検証です。**実APIの契約**は別問題であり、AT-07で1回だけ実送信して
確認します。モックの結果を「実APIで動く」証拠として扱いません。

## AT-01〜AT-20

| Test | 状態 | 証拠 | 残作業 |
|---|---|---|---|
| AT-01 | **合格** | `scripts/verify-integrity.mjs`: 400ノートのVaultで12検索を実行し、`node:https`/`node:http` への送信0件、CDPが観測したAPI宛リクエスト0件。既定は `enabled:false` | なし |
| AT-02 | 一部合格 | `test/search.test.ts`: 全角/半角/大小の正規化、見出し境界、frontmatter除外、チャンク境界1200/重複120、1始まり行番号、フェンス内`#`の無視を検証。実機E2Eで検索と結果表示を確認 | 結果クリックで**原文行へ移動**する実機確認 |
| AT-03 | **合格** | `scripts/verify-at-mock.mjs`: 実機でpreviewを開き「送信」を押し、**preview本文と送信本文が同一**（SHA-256先頭16桁 `43b15ce3c5eba075` が一致、8,656バイト）、宛先は `https://openrouter.ai/api/alpha/decisions`、`Authorization: Bearer` が付与されることを確認 | なし |
| AT-04 | **合格** | `scripts/verify-at-mock.mjs`（制御した応答）: 高スコア→並べ替えと `Jev ranked` 表示、全スコア0→**元順を保持**し「関連度が低いため元順を保持」、不正応答（`model` 不一致）→ `Local fallback: model-mismatch`。`test/jev.test.ts` が score/probability/警告の検証を担う。ADR-007により候補は削除しない | 一部バッチ失敗時の表示 |
| AT-05 | 一部合格 | `test/search.test.ts`: フォルダ境界、隠しディレクトリ、タグの完全一致と子孫、正規化パス | `configDir` 変更時の実機確認 |
| AT-06 | **合格** | `scripts/verify-at-mock.mjs`: 2.5秒遅延させた応答の到着前にqueryを変更。遅着した応答は**UIを上書きせず**、statusは新queryのローカル結果、先頭行も新queryの `notes/mocknote7.md` のままだった | キー変更中の実機試験 |
| AT-07 | 一部合格（Directは**実施不能**） | 2026-09-19にOpenRouter経由で合成データ1送信に成功。`model` が `typesafe/jev-1.13` に一致、`confidence`/`probabilities` の厳格検証を通過、実コスト $0.000016、4秒以内 | 3条件（live無効/キーのみ/live+キー）の明示的な比較と、Direct経路（TypeSafeのwaitlist待ち） |
| AT-08 | **合格** | `scripts/verify-integrity.mjs`: ダミー秘密を `secretStorage` に保存→読み戻し成功。プラグイン設定とVault内の全 `.md`/`.json` に出現0件。`scripts/verify-bundle.mjs` も同じ境界を検査 | なし |
| AT-09 | 一部合格 | `test/jev.test.ts`: 欠損ID、NaN、範囲外、probability不整合、`type` 不一致、`model` 不一致、provider警告を拒否 | HTMLを模擬した値の実機での表示確認 |
| AT-10 | **合格** | `scripts/verify-integrity.mjs`: 400ノートのSHA-256を起動前と正常終了後で比較。追加・削除・変更いずれも0件 | なし |
| AT-11 | 一部合格 | [実機負荷試験](benchmark/result-load-10k.md): 実Obsidian 1.13.4・合成10,000ノートで索引完了52.1s→16.4s、UI停止なし（フレーム間隔p95 17〜23ms、200ms超のフレームは各回2回）、ヒープ144〜251MB | 1ノート50MiB級の巨大ノートと、50MiB総量での試験 |
| AT-12 | **合格** | `scripts/verify-at12.mjs`: 20ノートのVaultで100件連続作成→50件編集→25件削除→10件改名。各段階で索引数がディスクと一致（120→95→95）、削除ノートは検索で見つからず、編集ノートは再索引され古い語は消えた。無効化/有効化5回の後も95件で一致、`pending` 0、タイマー残存0 | なし |
| AT-13 | 未実施 | — | 公開コーパスでの再実行（Phase C。Jev実APIが必要） |
| AT-14 | 一部合格 | CI（`.github/workflows/ci.yml`）がclean checkoutで `npm ci` → typecheck → test → build → `verify-bundle.mjs` を実行。版は `manifest.json`/`package.json`/`versions.json` で一致 | NOTICE整備と、release成果物の実検査 |
| AT-15 | **合格** | `scripts/verify-at-mock.mjs`: 応答しないモックで **4,497ms** で打ち切り `Local fallback: cancelled`、短い `Retry-After` で**2リクエスト**（1回再試行）、長い `Retry-After` で**1リクエスト**で `rate-limit`、取消を10回連打しても**物理リクエストは1**。`test/jev.test.ts` が事前取消も検証 | 実APIでの4秒超応答 |
| AT-16 | 一部合格 | `prepare()` が24KiB上限まで文書を削り、最大20文書に制限。previewに概算コストを表示 | 3バッチ必要時の未送信表示と予算停止の実機確認 |
| AT-17 | **合格** | `scripts/verify-at-mock.mjs`: preview表示中に候補ノートを削除→「送信」後も**新規リクエスト0件**。承認が無効化され、古いデータは送信されない | 本文変更・除外設定変更中の実機試験 |
| AT-18 | **合格** | `scripts/verify-at18.mjs`: 判定がキャッシュを往復、TTL 0で無効化、設定変更とアンロードで消去（1→0）、診断オブジェクトにパス・本文・クエリの漏れなし、`data.json` に判定が入らずTTLのみ保存。設定画面にキャッシュTTLと診断コピーが出る | なし |
| AT-19 | 一部合格 | 実機E2Eで検索入力と結果表示を確認。IMEは `compositionstart`/`compositionend` を実装 | Tab/Esc、ズーム200%、フォーカス復元の実機確認 |
| AT-20 | **合格** | `scripts/verify-at20.mjs`: 未来版を模した設定（配列でない `folders`、型混在の `tags`、文字列の `enabled`、配列の `endpoint`、パストラバーサル・大文字・200文字の `secrets`、未知キー）を置いて起動。全項目が安全な既定へ落ち、検索は動作し、レンダラ例外0、**保存ファイルは1バイトも変更されず**再解析も可能 | なし |

### 合格の内訳

実測で合格: **AT-01, AT-03, AT-04, AT-06, AT-08, AT-10, AT-12, AT-15, AT-17, AT-18, AT-20**（11件）
一部合格: AT-02, AT-05, AT-07, AT-09, AT-11, AT-14, AT-16, AT-19（8件）
未実施: AT-13（1件）
実施不能: AT-07のDirect経路

## RV-01〜RV-05

| ID | 状態 | 現在分かっていること |
|---|---|---|
| RV-01 送信確認の操作負担 | **未検証** | ローカル検索は確認なし、「Jevで並べ替え」は毎回確認。操作数・所要時間・承認中断は未計測。非開発者ベータが必要 |
| RV-02 BM25の候補漏れ | **大きく前進** | [合成コーパス計測](benchmark/result-synthetic-recall.md): 10,000ノートで Recall@50 70.8%、`matchedAnywhere` 87.5%。48問中**6問は共通語がゼロ**でBM25では原理的に届かない。8問は語は一致するが順位が低い（中央値395位）。**語彙の壁はVault規模に依存せず、順位劣化は依存する。** カットを1000に上げても81.3%で、候補を増やすだけでは解決しない |
| RV-03 取消と通信枠 | 一部合格 | `requestUrl` を使わず `node:https` + `AbortController` で実装。リダイレクトを追わず、資格情報を他ホストへ転送しない。`test/jev.test.ts` で事前取消・取消中の挙動を検証 | 物理同時接続数1の実機確認 |
| RV-04 キー再入力の負担 | **解決** | Obsidian SecretStorage（`@since 1.11.4`）に保存し、**通常の再起動後も保持される**ことを実機で確認（`scripts/run-gui-e2e.mjs` の再起動テスト）。**プロファイル単位でVault単位ではない**ことも実測した（設計書04）。強制終了直後は書き込みが失われるため、正常終了が必要 |
| RV-05 バッチ内だけの並べ替え | 未検証 | 設計上、Jevはローカル上位N件しか並べ替えない。したがって品質の上限は候補段階の再現率（RV-02の数値）で決まる。Jev適用後のnDCG変化は未計測（Phase C） |

## この版を一般公開しない理由

`docs/design/07-acceptance.md` の規定どおり、**重大要件の未実施が残る版を一般向け安定版として公開しません**。

- **AT-13（公開コーパスでの再現）が未実施**。G3の要件であり、Jev実APIと公開コーパスが必要
- AT-07 のDirect経路が実施不能（TypeSafeのwaitlist待ち）
- AT-02/05/09/11/16/19 の残作業（上表）

現在できる主張は「合成Vaultと実Obsidian 1.13.4で、送信0件・Vault無変更・秘密漏れ0件・
10,000ノートで索引16.4秒・承認した本文と同一の本文だけを送信・4秒で打ち切り・取消を10回連打しても
物理リクエスト1回を実測した」までです。
**「高精度」「産業レベル」「意味検索」とは主張しません。**

## 再現

```
npm run verify                              # typecheck, unit tests, build, bundle boundary
node scripts/verify-integrity.mjs --vault=.sandbox/corpus-small/vault
node scripts/load-test.mjs --vault=.sandbox/load-vault --profile=.sandbox/load-profile
node scripts/verify-at12.mjs
node scripts/verify-at18.mjs
node scripts/verify-at20.mjs
npm run test:gui                            # real-Obsidian GUI E2E, needs a display
```
