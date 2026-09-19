# Jev投入後のnDCG（公開コーパス・実API）

最終更新: 2026-09-19 / Obsidian 1.13.7 / プラグイン0.1.0 / モデル `typesafe/jev-1.13`

## 問い

[公開コーパスでの測定](result-public-corpus.md) では、**ローカル段**の再現率を測りました。
この文書はその次の問い、**Jevが候補の順序を良くするか**を測ります。

## 方法

- コーパス: 日本語版Wikipediaの導入部806記事（`bff129d78431da32`）
- クエリ: コーパスから取った**カタカナ語**400件。関連文書は「その語を含む文書」で、
  **Jevの判断ではなくコーパスから**決めます。Jevを自分の意見で採点しないためです。
- 手順: ローカル段で上位20件を取得 → そのうち予算に収まる件をJevが `score` →
  スコア降順に並べ替え（**候補は削除しない**。全スコアが1未満ならローカル順を維持）
- 指標: nDCG@10。理想は「関連文書が上位10件を占めた場合」
- 実行: `node scripts/live-with-stored-key.mjs --script=scripts/measure-ndcg.mjs --queries=120`

## 結果

| クエリ数 | nDCG@10 前 | nDCG@10 後 | 改善 | 悪化 | 不変 | 実API失敗 |
|---|---|---|---|---|---|---|
| 40 | 0.4534 | **0.8131** | 23 | 1 | 16 | 0 |
| 120 | 0.5258 | **0.8788** | 75 | 1 | 44 | 0 |

120件の内訳は、**75件が改善・1件が悪化・44件が不変**です。40件の結果は120件の先頭部分集合なので、
同じ傾向が規模を変えても出ています。

## 解釈

- ローカル段は**候補をほぼ取り切って**います（カタカナ語クエリの `matchedAnywhere` は100%）。
  つまりこの改善は**順序だけ**の改善で、再現率の改善ではありません。
- nDCG@10が0.88という値は「上位10件の並びがほぼ理想どおり」を意味します。ただしこれは
  **このコーパス・このクエリ集合・この関連度定義**での話です。
- **1件は悪化しています。** 平均だけを見て「必ず良くなる」とは書きません。

## 測っていないこと

- 日本語の自然文クエリ（このクエリ集合はカタカナ語1語）
- 長いノート、リンクやタグを含む実Vault
- Jevの判断が**誤っていた**場合の影響（関連度をJevから取っていないので、その誤りは測れません）
- クエリ数120での信頼区間。点推定です。

## 副次的に見つかったこと

**CDPではこの送信を観測できません。** プラグインは `node:https` で送るため、Chromiumの
ネットワークスタックを通りません。そのため [3条件の実APIテスト](../../scripts/verify-at07-conditions.mjs)
では `require("node:https").request` を数える計器を併用しています。CDPの観測だけを
「送信0件」の根拠にすると、**送信を見逃します**。

## 再現

```
node scripts/fetch-public-corpus.mjs --out=.sandbox/wiki
node scripts/experiment-katakana-qrels.mjs --truth-out=.sandbox/wiki/katakana-truth.json
node scripts/launch-obsidian.mjs 9222
node scripts/live-with-stored-key.mjs --script=scripts/measure-ndcg.mjs --queries=120 --out=.sandbox/wiki/ndcg-120.json
```
