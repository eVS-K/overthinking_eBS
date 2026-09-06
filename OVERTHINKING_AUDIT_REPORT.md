# OVERTHINKING Comprehensive Audit Report

監査日: 2026-09-05 JST。**監査中の台帳。件数・採否は最終相互検証後に確定。**

## 1. Executive Summary

ユーザーの追加指示によりAudit-only。製品修正、新規テスト追加、依存更新、デプロイは実施しない。最終成果物は本ファイルだけ。

## 2. Audit Scope

- Repository: https://github.com/eVS-K/overthinking_eBS (origin)。upstream: https://github.com/dub-227/overthinking_demo。
- 開始branch `main`、HEAD `f2caadff436cd159d3e57d9d702daec4b62b30f9`、working tree clean。
- Windows / PowerShell / Node.js24.19.0。導入済みexpress5.2.1、pg8.23.0、socket.io/client4.8.3。
- 方針変更前に回帰テスト準備として追加した `@playwright/test@1.63.0` と関連3パッケージは、自分だけの差分と照合しpackage.json / package-lock.jsonから除去、node_modules追加分も除去。製品ソース・テスト・ルールは一度も変更していない。git diff --exit-codeは0。ブラウザ取得キャッシュと既存テストが再生成したgitignored value tableは非製品調査生成物。
- npm run test:ci baseline PASS: syntax71 files、Node200 tests、8 core-module coverage gates。ログをTEMPへ保存。
- 公開主要5ファイルは開始HEADと一致。/health200 ranked available、/readyz200 Guest/Ranked ready。公開ランキング表示確認。GitHub同HEADのCIはWindows/Linux/PostgreSQL成功。
- PostgreSQL: docker / psql / postgresはPATHで見つからず。隔離DBなし。破壊的DBテストは実行しない。

## 3. Architecture / Trust Boundary

静的HTML/CSS/JS → Express / Socket.IO。Guest Private / Randomの部屋・待機列・再接続・制限器は単一プロセスメモリ。Ranked / Auth / Privateプリセットは同一origin Cookie認証RESTとPostgreSQL。SupabaseはOAuth仲介。SQL5 migrations。Renderがゲーム実行origin、GitHub Pagesは旧リンク・起動待ちgateway。

不変条件: クラシック7枚、7ラウンドまたは9枚以上獲得。判定正本game-rules.js。Private拡張は別設定検証・カード実体・純粋エンジンでRandom/Rankedへ混入しない。設定は開始時凍結。確定した選択は非公開、残り手札は公開。得点・乱数・勝敗・評価はサーバー決定。

## 4. Coverage Matrix

実施中。SECURITY / TESTING / .env.example / CI / migrations / Private設計3文書は確認済み。

## 5. Finding Summary

最終件数は検証後に確定。

## 6. Critical & Major Findings

現在の候補には本番侵害と確認できたP0はない。重大候補は相互検証中。

## 7. Complete Finding Catalog

以下は作業継続用の候補台帳。最終版で採否・Severity・Confidence・Statusを確定する。

- C01 stale consent: server agreeToStartはconfigRevisionを読まずmainも送らない。旧revision1クリックをhost変更revision2後に送ると60秒新設定でplaying。実Socketで前担当が再現、再検証中。
- C02 stale action: confirm_cardにmatch/round fenceなし。round1 Blank確定をround2へ再送すると新round選択済み。classic旧対局の札・降参にも類似経路候補。重複統合を検討。
- C03 keyboard focus: AがAceをEnterで選択→BがKing確定→Aのdocument.activeElementがDIV AceからBODYへ。Coordinatorが実ブラウザ確認。renderRoom→renderHandの全置換でfocus維持指定なし。
- C04 local auth: createAuthConfig HTTP localhost cookieSecure=falseでも__Host-cookie名固定。prefix条件不成立でbrowser拒否。コード確認済み、browser検証待ち。
- C05 leaderboard cache: opt-outのDB transaction内COMMIT前にinvalidate。並行readerが旧visible値を新cache generationへ格納しCOMMIT後も表示。gate-controlled reproduction前担当報告、再検証中。
- C06 split read: getActiveGame/resumeがgame rowとlistMovesを別SQLでREAD COMMITTED取得。間にmoveがcommitするとround1 stateとround1 history(実DB round2)の混合response。gate-controlled reproduction前担当報告、再検証中。
- C07 value artifact: initial entry vと全qを0へ変更、checksum再計算するとmetadata goldenを保持したままvalidateRankedValueTableが受理。実初期値照合/Bellman整合性検証不足。前担当の局所実験、Coordinator再検証待ち。
- C08 destructive test guard: databaseEndpointIdentityはquery.get(port)の最初の値、pgは最後を使う。DATABASE_URLの?port=9999&port=5432とTESTの:5432が同一DBでも許可。localhost/127別表記も候補。DB接続なしでparser照合済みの前担当報告、再検証中。
- C09 dependency: npm auditはqsにmoderate2 advisories(GHSA-x5fp-wj9c-mxmx/GHSA-4mjr-xmp4-gh2g)。到達可能性を確認せず脆弱性と断定しない。

## 8. Game Logic Findings

調査継続中。

## 9. Multiplayer / Socket.IO Findings

調査継続中。

## 10. Authentication / Security Findings

調査継続中。

## 11. Database / Persistence Findings

調査継続中。

## 12. Frontend / UX / Accessibility Findings

ローカル127.0.0.1:3000にA/B別タブ入室。両者同意・A Ace対B King・A2枚獲得・round2への遷移確認。C03を再現。ローカルRanked未設定の保存機能unavailableは想定どおり。新規ブラウザテストファイルは追加しない。

## 13. Performance / Reliability Findings

調査継続中。

## 14. Testing / CI Findings

既存テストを実行し、テスト自体も監査する。今回は新しい製品テストを追加しない。

## 15. Deployment / Operations Findings

調査継続中。本番観察は低負荷のみ。

## 16. Maintainability Findings

調査継続中。

## 17. Ambiguous Specifications

ロック/秘匿/対象選択/コピー/生成など設計上保留のTarotは、未実装自体を不具合と数えない。

## 18. Rejected / Disproved Findings

手札公開は仕様。ランダム相手はsolver最適AIではなく一様randomが仕様。Joker通常draw、Two対AceとThree対Joker例外は正本・UI・全組合せテスト一致。

## 19. Recommended Fix Order

採否・影響確認後に確定。今回は提案のみ。

## 20. Remaining Unknowns

本番OAuth/DB管理画面・共有DB設定・全端末browserは未実施。コード上の推測で埋めない。

## 21. Audit Limitations

問題不存在の証明ではない。明示的な仕様・実挙動・test証拠を区別し、未確認候補はConfirmedにしない。
