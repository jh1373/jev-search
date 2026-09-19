# 受入テストの実施状況 — 設計版0.2 / 実装0.1.0

最終更新: 2026-09-19（commit `4e33f2a`）

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

## AT-01〜AT-20

| Test | 状態 | 証拠 | 残作業 |
|---|---|---|---|
| AT-01 | **合格** | `scripts/verify-integrity.mjs`: 400ノートのVaultで12検索を実行し、`node:https`/`node:http` への送信0件、CDPが観測したAPI宛リクエスト0件。既定は `enabled:false` | なし |
| AT-02 | 一部合格 | `test/search.test.ts`: 全角/半角/大小の正規化、見出し境界、frontmatter除外、チャンク境界1200/重複120、1始まり行番号、フェンス内`#`の無視を検証。実機E2Eで検索と結果表示を確認 | 結果クリックで**原文行へ移動**する実機確認 |
| AT-03 | 一部合格 | `prepare()` はpreviewと送信で同一の文字列を返すため、承認したbodyと送信bodyは構造上一致する。取消時は `send` を呼ばない | HTTP spy によるbody一致の実測 |
| AT-04 | 一部合格 | `test/jev.test.ts`: score 0〜2、confidence、probability分布の整合、model不一致・警告の拒否。ADR-007によりJevスコアで候補を削除しない | 全低関連・一部失敗時の実機での順序とstatus表示 |
| AT-05 | 一部合格 | `test/search.test.ts`: フォルダ境界、隠しディレクトリ、タグの完全一致と子孫、正規化パス | `configDir` 変更時の実機確認 |
| AT-06 | 未実施 | 世代番号と `epoch` による破棄は実装済み | 送信待ち中の新query・ノート削除・キー変更の実機試験 |
| AT-07 | 一部合格（Directは**実施不能**） | 2026-09-19にOpenRouter経由で合成データ1送信に成功。`model` が `typesafe/jev-1.13` に一致、`confidence`/`probabilities` の厳格検証を通過、実コスト $0.000016、4秒以内 | 3条件（live無効/キーのみ/live+キー）の明示的な比較と、Direct経路（TypeSafeのwaitlist待ち） |
| AT-08 | **合格** | `scripts/verify-integrity.mjs`: ダミー秘密を `secretStorage` に保存→読み戻し成功。プラグイン設定とVault内の全 `.md`/`.json` に出現0件。`scripts/verify-bundle.mjs` も同じ境界を検査 | なし |
| AT-09 | 一部合格 | `test/jev.test.ts`: 欠損ID、NaN、範囲外、probability不整合、`type` 不一致、`model` 不一致、provider警告を拒否 | HTMLを模擬した値の実機での表示確認 |
| AT-10 | **合格** | `scripts/verify-integrity.mjs`: 400ノートのSHA-256を起動前と正常終了後で比較。追加・削除・変更いずれも0件 | なし |
| AT-11 | 一部合格 | [実機負荷試験](benchmark/result-load-10k.md): 実Obsidian 1.13.7・合成10,000ノートで索引完了52.1s→16.4s、UI停止なし（フレーム間隔p95 17〜23ms、200ms超のフレームは各回2回）、ヒープ144〜251MB | 1ノート50MiB級の巨大ノートと、50MiB総量での試験 |
| AT-12 | **合格** | `scripts/verify-at12.mjs`: 20ノートのVaultで100件連続作成→50件編集→25件削除→10件改名。各段階で索引数がディスクと一致（120→95→95）、削除ノートは検索で見つからず、編集ノートは再索引され古い語は消えた。無効化/有効化5回の後も95件で一致、`pending` 0、タイマー残存0 | なし |
| AT-13 | 未実施 | — | 公開コーパスでの再実行（Phase C。Jev実APIが必要） |
| AT-14 | 一部合格 | CI（`.github/workflows/ci.yml`）がclean checkoutで `npm ci` → typecheck → test → build → `verify-bundle.mjs` を実行。版は `manifest.json`/`package.json`/`versions.json` で一致 | NOTICE整備と、release成果物の実検査 |
| AT-15 | 一部合格 | `test/jev.test.ts`: 429の1回再試行、長い `Retry-After` で再試行しないこと、事前取消で送信しないこと、全体4秒の期限 | 実機での4秒超応答、取消連打、物理同時1の確認 |
| AT-16 | 一部合格 | `prepare()` が24KiB上限まで文書を削り、最大20文書に制限。previewに概算コストを表示 | 3バッチ必要時の未送信表示と予算停止の実機確認 |
| AT-17 | 未実施 | — | preview中の除外変更・本文変更による承認無効化の実機試験 |
| AT-18 | 未実施 | — | cache/診断/アンインストールの検査 |
| AT-19 | 一部合格 | 実機E2Eで検索入力と結果表示を確認。IMEは `compositionstart`/`compositionend` を実装 | Tab/Esc、ズーム200%、フォーカス復元の実機確認 |
| AT-20 | 未実施 | 設定の検証は `list()`/`secrets()` で未知値を既定へ落とす実装 | 旧版への戻しと未知schemaでの実機試験 |

### 合格の内訳

実測で合格: **AT-01, AT-08, AT-10, AT-12**（4件）
一部合格: AT-02, AT-03, AT-04, AT-05, AT-07, AT-09, AT-11, AT-14, AT-15, AT-16, AT-19（11件）
未実施: AT-06, AT-13, AT-17, AT-18, AT-20（5件）
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

- AT-06, AT-13, AT-17, AT-18, AT-20 が未実施
- AT-07 のDirect経路が実施不能
- AT-13（公開コーパスでの再現）が未実施

現在できる主張は「合成Vaultと実Obsidianで、送信0件・Vault無変更・秘密漏れ0件・10,000ノートで索引16.4秒を実測した」までです。
**「高精度」「産業レベル」「意味検索」とは主張しません。**

## 再現

```
npm run verify                              # typecheck, unit tests, build, bundle boundary
node scripts/verify-integrity.mjs --vault=.sandbox/corpus-small/vault
node scripts/load-test.mjs --vault=.sandbox/load-vault --profile=.sandbox/load-profile
node scripts/verify-at12.mjs
npm run test:gui                            # real-Obsidian GUI E2E, needs a display
```
