#!/usr/bin/env node
// Deterministic synthetic vault generator for retrieval measurement.
//
// It produces a vault plus a ground-truth file. Every note is generated from a seeded PRNG, so
// the same seed always yields byte-identical notes: AT-13 requires a reproducible corpus.
//
// The corpus deliberately mixes four kinds of note:
//   grade 2  the note states the fact a query asks for
//   grade 1  the note is about the same subject but does not answer the query
//   grade 0  a distractor that shares surface vocabulary with some subject but is about something else
//   noise    ordinary notes (diaries, recipes, logs) with no relation to any query
//
// Queries come in two flavours per subject: one that reuses the note's wording and one that asks
// the same thing in different words. The gap between them is the synonym gap RV-02 warns about.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each subject carries a fact (the thing a grade-2 note states), the wording a note uses, and two
// ways of asking for it. The synonym query deliberately avoids the note's distinctive nouns.
const SUBJECTS = [
  { key: 'expense-deadline', subject: '経費精算の締め日', fact: '経費精算の締め日は毎月25日で、それ以降の申請は翌月に回されます。', noteWords: ['経費精算', '締め日', '申請期限'], query: '経費精算の締め日はいつですか', synonym: '立て替えたお金はいつまでに申請すればいい' },
  { key: 'vpn', subject: '社外からの接続方法', fact: '社外から社内システムへ入るにはVPNクライアントを使い、多要素認証を済ませてから接続します。', noteWords: ['VPN', '多要素認証', 'リモートアクセス'], query: 'VPN接続の手順を教えて', synonym: '家から社内のシステムを使うにはどうすればいい' },
  { key: 'meeting-room', subject: '会議室の予約', fact: '会議室は予約システムで30分単位に押さえられ、開始15分前を過ぎた未使用の予約は自動で解除されます。', noteWords: ['会議室', '予約', '自動解除'], query: '会議室の予約ルールは', synonym: '打ち合わせに使う部屋はどうやって押さえる' },
  { key: 'deploy', subject: '本番反映の手順', fact: '本番への反映は火曜と木曜の14時からで、承認済みのリリースノートが必要です。', noteWords: ['本番反映', 'デプロイ', 'リリース'], query: 'デプロイはいつできる', synonym: '作ったものを利用者に届ける手順と時間帯' },
  { key: 'backup', subject: 'バックアップの保持期間', fact: 'データベースのバックアップは日次で取得し、直近90日分を保持します。', noteWords: ['バックアップ', '保持期間', '日次'], query: 'バックアップは何日分残る', synonym: '壊れたときに戻せるのはどこまで昔までか' },
  { key: 'password', subject: 'パスワードの条件', fact: 'パスワードは12文字以上で、90日ごとの変更と過去5件との重複禁止を求めます。', noteWords: ['パスワード', '文字数', '有効期限'], query: 'パスワードの条件は', synonym: 'ログインの合言葉に求められる決まり' },
  { key: 'health-check', subject: '健康診断の受診', fact: '健康診断は毎年10月に社内で実施し、予約は9月の第2週から始まります。', noteWords: ['健康診断', '予約', '10月'], query: '健康診断はいつ', synonym: '体の検査を受ける時期と申し込み方' },
  { key: 'paid-leave', subject: '有給休暇の申請', fact: '有給休暇は3営業日前までに申請し、連続5日を超える場合は事前に上長の承認が必要です。', noteWords: ['有給休暇', '申請', '承認'], query: '有給はいつまでに出す', synonym: '休みを取るときの決まりと締め切り' },
  { key: 'cert-renew', subject: '証明書の更新', fact: 'サーバー証明書は有効期限の30日前に更新し、更新後は必ずステージングで確認します。', noteWords: ['証明書', '更新', '有効期限'], query: '証明書の更新手順は', synonym: '暗号化通信の期限が切れる前にやること' },
  { key: 'helpdesk', subject: '問い合わせ窓口', fact: '社内の困りごとはヘルプデスクへ連絡し、一次応答は1営業日以内です。', noteWords: ['ヘルプデスク', '問い合わせ', '一次応答'], query: '社内の問い合わせ窓口はどこ', synonym: 'パソコンの調子が悪いとき誰に言えばいい' },
  { key: 'timecard', subject: '勤怠の入力', fact: '勤怠は当月分を翌月3営業日までに入力し、修正は上長の承認を伴います。', noteWords: ['勤怠', '入力', '締め'], query: '勤怠の入力期限は', synonym: '働いた時間はいつまでに記録する' },
  { key: 'supplies', subject: '備品の購入', fact: '1万円未満の備品は部門予算で直接購入でき、それ以上は稟議が必要です。', noteWords: ['備品', '購入', '稟議'], query: '備品を買うときの上限は', synonym: '文房具などを買うのに必要な手続き' },
  { key: 'business-trip', subject: '出張の申請', fact: '出張は出発の2週間前までに申請し、海外の場合は1か月前までとします。', noteWords: ['出張', '申請', '海外'], query: '出張申請の期限は', synonym: '遠くへ行くときの事前の届け出' },
  { key: 'incident', subject: '障害の初動', fact: '障害を検知したら15分以内に第一報を上げ、影響範囲と暫定対応を共有します。', noteWords: ['障害', '第一報', '暫定対応'], query: '障害が起きたらまず何をする', synonym: 'システムが止まったときの最初の動き' },
  { key: 'review', subject: 'コードレビューの規則', fact: 'コードレビューは2名以上の承認を必要とし、1営業日以内に一次応答を返します。', noteWords: ['コードレビュー', '承認', '一次応答'], query: 'コードレビューの決まりは', synonym: '書いたプログラムを誰に確認してもらうか' },
  { key: 'retention', subject: 'データの保持', fact: '利用者データは契約終了から6か月後に削除し、削除記録を3年間保管します。', noteWords: ['保持', '削除', '契約終了'], query: 'データはいつ消すのか', synonym: '預かった情報をいつまで置いておくか' },
  { key: 'personal-data', subject: '個人情報の扱い', fact: '個人情報を含むファイルは共有フォルダに置かず、指定の保管庫へ移動します。', noteWords: ['個人情報', '保管庫', '共有フォルダ'], query: '個人情報の置き場所は', synonym: '人名や連絡先を含む書類のしまい方' },
  { key: 'log', subject: 'ログの保存', fact: 'アプリケーションログは30日、監査ログは1年間保存します。', noteWords: ['ログ', '保存', '監査'], query: 'ログはどれくらい残す', synonym: '動作の記録をいつまで保管するか' },
  { key: 'oncall', subject: '当番の連絡網', fact: '休日や夜間の緊急連絡は当番の携帯へ入れ、15分以内に折り返します。', noteWords: ['当番', '緊急連絡', '携帯'], query: '夜中の緊急連絡はどうする', synonym: '休みの日に問題が起きたときの連絡先' },
  { key: 'security-training', subject: '研修の受講', fact: '情報セキュリティ研修は年2回で、未受講の場合は本番環境へのアクセスが停止されます。', noteWords: ['研修', 'セキュリティ', '受講'], query: 'セキュリティ研修はいつ', synonym: '決められた勉強会を受けないとどうなるか' },
  { key: 'badge', subject: '入館証', fact: '入館証を失くした場合は総務へ届け出て、再発行までは仮証を使います。', noteWords: ['入館証', '再発行', '総務'], query: '入館証をなくしたら', synonym: '社屋に入るカードを落としたときの手続き' },
  { key: 'approval', subject: '稟議の流れ', fact: '稟議は起案から3段階の承認を経て、金額が100万円を超えると役員会に上がります。', noteWords: ['稟議', '承認', '役員会'], query: '稟議はどう流れる', synonym: '大きな買い物の決裁の順番' },
  { key: 'contract', subject: '契約の更新', fact: '契約の更新は満了の60日前までに判断し、更新しない場合は書面で通知します。', noteWords: ['契約', '更新', '通知'], query: '契約更新の期限は', synonym: '続けるかどうかを決める締め切り' },
  { key: 'estimate', subject: '見積もりの提出', fact: '見積もりは依頼から5営業日以内に提出し、有効期限は発行から30日です。', noteWords: ['見積もり', '提出', '有効期限'], query: '見積もりはいつまでに出す', synonym: '金額の提示にかかる日数と期限' },
];

const FILLER_TOPICS = ['議事録', '作業ログ', '調査メモ', '学習記録', '買い物', '旅行', '料理', '読書', '雑感', '整理'];
const FILLER_SENTENCES = [
  '今日は午前中にまとめて片づけた。', '思ったより時間がかかったので明日に回す。',
  'あとで見返すように印を付けておく。', '担当を決めずに進めたら少し混乱した。',
  '数字だけ見ると悪くないが、中身はもう少し確認が要る。', '来週また同じ話題が出るはず。',
  '資料は共有フォルダに置いた。', '一度手を止めて手順を見直した。',
  '小さく試してから広げる方が安全そうだ。', '結論は出なかったが論点は整理できた。',
  '思いついた順に書き出したので後で並べ替える。', '以前のやり方をそのまま使うことにした。',
  '担当者に確認してから決める。', '作業の半分は単純な繰り返しだった。',
  '見積もりより早く終わった。', '前提が変わったので一度戻す。',
];
const FILLER_TITLES = ['打ち合わせ', '作業', '確認', '相談', '調査', '検討', '整理', '記録', '下書き', '覚書'];
const RECIPES = ['肉じゃが', '味噌汁', 'カレー', '親子丼', '筑前煮', 'ほうれん草のおひたし', '豚の生姜焼き', '卵焼き', 'きんぴら', '茶碗蒸し'];
const BOOKS = ['失敗の本質', 'リーン・スタートアップ', '人を動かす', '7つの習慣', 'ファスト&スロー', 'リファクタリング', '達人プログラマー', 'ドメイン駆動設計', 'Clean Architecture', 'ハイパフォーマンスMySQL'];

function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }

function ymd(rng, base, spanDays) {
  const d = new Date(base + Math.floor(rng() * spanDays) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

export function buildCorpus({ notes, seed }) {
  const rng = mulberry32(seed);
  const base = Date.UTC(2024, 0, 1);
  const files = [];
  const truth = [];
  const used = new Set();
  const add = (path, text) => { used.add(path); files.push({ path, text }); return path; };

  // One grade-2 note per subject, filed under a plausible folder for that kind of rule.
  const grade2 = new Map();
  for (const s of SUBJECTS) {
    const path = '規程/' + s.subject + '.md';
    const body = [
      '# ' + s.subject,
      '',
      '## 概要',
      s.fact,
      '',
      '## 補足',
      '担当は総務部です。変更があった場合はこのノートを更新します。',
      '関連する用語: ' + s.noteWords.join('、') + '。',
      '',
    ].join('\n');
    add(path, body);
    grade2.set(s.key, path);
  }

  // Grade-1 notes: the same subject, discussed without stating the fact.
  for (const s of SUBJECTS) {
    const path = '議事録/' + s.subject + '-検討.md';
    add(path, [
      '# ' + s.subject + 'の検討',
      '',
      '## 論点',
      s.subject + 'について、現行の運用で困っている点を洗い出した。',
      s.noteWords.join('と') + 'の扱いをどうするかが主な争点になった。',
      '結論は次回に持ち越し。数字の裏取りがまだ足りない。',
      '',
      '## 宿題',
      '- 現行の手順を書き出す',
      '- 他部門の例を集める',
      '',
    ].join('\n'));
    truth.push({ key: s.key, path, grade: 1 });
  }

  // Distractors share vocabulary with two subjects but belong to neither.
  for (let i = 0; files.length < Math.floor(notes * 0.25); i++) {
    const a = SUBJECTS[i % SUBJECTS.length];
    const b = SUBJECTS[(i * 7 + 3) % SUBJECTS.length];
    const path = 'メモ/' + a.noteWords[0] + '-' + b.noteWords[0] + '-' + i + '.md';
    add(path, [
      '# ' + a.noteWords[0] + 'と' + b.noteWords[0] + 'の比較',
      '',
      a.noteWords.join('、') + 'という言葉と、' + b.noteWords.join('、') + 'という言葉が',
      '同じ会話に出てきたので整理しておく。',
      '実際には別の話であり、片方は今期の計画、もう片方は来期の構想である。',
      '混同しないよう用語集を分けることにする。',
      '',
    ].join('\n'));
  }

  // Fillers: diaries, recipes, book notes, logs, code notes.
  let n = 0;
  while (files.length < notes) {
    const r = rng();
    const stamp = ymd(rng, base, 700);
    if (r < 0.3) {
      const path = '日記/' + stamp + '-' + n + '.md';
      const lines = ['# ' + stamp + 'の記録', ''];
      const count = 3 + Math.floor(rng() * 6);
      for (let k = 0; k < count; k++) lines.push(pick(rng, FILLER_SENTENCES));
      add(path, lines.join('\n') + '\n');
    } else if (r < 0.5) {
      const path = '作業ログ/' + stamp + '-' + pick(rng, FILLER_TITLES) + '-' + n + '.md';
      add(path, [
        '# 作業ログ ' + stamp,
        '',
        '## やったこと',
        '- ' + pick(rng, FILLER_SENTENCES),
        '- ' + pick(rng, FILLER_SENTENCES),
        '',
        '## 次にやること',
        '- ' + pick(rng, FILLER_SENTENCES),
        '',
        '```',
        'const value = compute(input);',
        'console.log(value);',
        '```',
        '',
      ].join('\n'));
    } else if (r < 0.65) {
      const dish = pick(rng, RECIPES);
      add('レシピ/' + dish + '-' + n + '.md', [
        '# ' + dish,
        '',
        '## 材料',
        '- 主材料 適量',
        '- 調味料 少々',
        '',
        '## 作り方',
        '1. 材料を切る。',
        '2. 火にかけて' + (10 + Math.floor(rng() * 20)) + '分ほど煮る。',
        '3. 味を調えて完成。',
        '',
        'タグ: #料理 #' + dish,
        '',
      ].join('\n'));
    } else if (r < 0.78) {
      const book = pick(rng, BOOKS);
      add('読書/' + book + '-' + n + '.md', [
        '# ' + book,
        '',
        '## 印象に残った点',
        pick(rng, FILLER_SENTENCES),
        pick(rng, FILLER_SENTENCES),
        '',
        '## 自分の仕事への当てはめ',
        'すぐには使えないが、判断の順序を変える手がかりにはなりそうだ。',
        '',
      ].join('\n'));
    } else if (r < 0.9) {
      add('プロジェクト/' + pick(rng, FILLER_TOPICS) + '-' + n + '.md', [
        '# ' + pick(rng, FILLER_TOPICS) + 'プロジェクト',
        '',
        '| 項目 | 内容 |',
        '|---|---|',
        '| 目的 | ' + pick(rng, FILLER_SENTENCES) + ' |',
        '| 期間 | ' + stamp + ' から 3か月 |',
        '| 担当 | 未定 |',
        '',
        pick(rng, FILLER_SENTENCES),
        '',
      ].join('\n'));
    } else {
      // Deliberately huge note: exercises chunking and the 1200-point split.
      const path = '長文/網羅メモ-' + n + '.md';
      const parts = ['# 網羅メモ ' + n, ''];
      for (let s = 0; s < 12; s++) {
        parts.push('## 節' + (s + 1));
        for (let k = 0; k < 12; k++) parts.push(pick(rng, FILLER_SENTENCES));
        parts.push('');
      }
      add(path, parts.join('\n'));
    }
    n++;
  }

  for (const s of SUBJECTS) {
    truth.push({ key: s.key, path: grade2.get(s.key), grade: 2 });
    truth.push({ key: s.key, query: s.query, kind: 'literal' });
    truth.push({ key: s.key, query: s.synonym, kind: 'synonym' });
  }
  return { files, truth, subjects: SUBJECTS };
}

async function main() {
  const arg = (name, fallback) => {
    const hit = process.argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const out = arg('out', '.sandbox/corpus/vault');
  const notes = Number(arg('notes', '10000'));
  const seed = Number(arg('seed', '20260919'));
  const clean = process.argv.includes('--clean');

  const { files, truth, subjects } = buildCorpus({ notes, seed });
  if (clean) await rm(out, { recursive: true, force: true });
  for (const file of files) {
    const target = join(out, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  const hash = createHash('sha256');
  for (const file of files.slice().sort((a, b) => a.path < b.path ? -1 : 1)) hash.update(file.path + '\0' + file.text + '\0');
  const corpusHash = hash.digest('hex');
  const queries = truth.filter(t => t.query);
  await writeFile(join(out, '..', 'ground-truth.json'), JSON.stringify({
    seed, notes: files.length, subjects: subjects.length, corpusHash,
    relevance: truth.filter(t => t.grade), queries,
  }, null, 2));
  const byGrade = { 1: truth.filter(t => t.grade === 1).length, 2: truth.filter(t => t.grade === 2).length };
  console.log(JSON.stringify({ notes: files.length, subjects: subjects.length, queries: queries.length, relevance: byGrade, corpusHash: corpusHash.slice(0, 16), out }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
