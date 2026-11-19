# 安全の問題の知らせ方 / Reporting a security issue

## 日本語

このリポジトリにあるのは、GitHub Actions の再利用のワークフロー（`.github/workflows/shared-check.yml`）と、その道具（`tools/`）と、目録（`repos.json`）と、文書です。
ワークフローと道具は、このリポジトリを呼ぶ運営者のほかのリポジトリの Actions の中で動きます。
呼ばれたワークフローは、読む権限だけを持ち、鍵を読まず、公開のリポジトリを読むだけの複製として取り出します。
サーバーで動く仕組みも、cookie もありません。
このワークフローと道具についての報告も、この窓口で受けます。
たとえば、呼んだリポジトリの鍵や書く権限に届く道、式を通して入り込む命令、固めていないコードが動く道です。

安全の問題は、公開の issue ではなく、メールで受けます。
宛先は、運営者の [ORCID の記録](https://orcid.org/0009-0000-1406-0547)にあるメールアドレスです。
運営者のほかのリポジトリの窓口と同じ宛先です。
GitHub の非公開の脆弱性報告（private vulnerability reporting）は、このリポジトリでは有効になっていません。
2026-11-19 に、GitHub の API（`/repos/cpsbvbng26-dotcom/verification-hub/private-vulnerability-reporting`）で確かめました。

秘密の鍵や個人の連絡先が載っているのを見つけたときも、同じ宛先で受けます。
その記載は、判断の前に外します。

答えは 7 日以内を目指します。
報奨金はありません。
直したものは、差し支えのない範囲で、変更の記録に残します。

## English

This repository holds a reusable GitHub Actions workflow (`.github/workflows/shared-check.yml`), its tools (`tools/`), its list of repositories (`repos.json`), and documents.
The workflow and the tools run inside the Actions of the operator's other repositories that call this repository.
The called workflow holds only the permission to read, reads no secrets, and takes read-only copies of public repositories.
Nothing runs on a server, and nothing sets a cookie.
Reports about the workflow and the tools are in scope here.
Examples are a path to the calling repository's secrets or write permissions, a command injected through an expression, and a path by which code that is not pinned runs.

Security issues are received by email, not in a public issue.
The address is the one on the operator's [ORCID record](https://orcid.org/0009-0000-1406-0547).
It is the same contact as for the operator's other repositories.
GitHub's private vulnerability reporting is not enabled for this repository.
This was checked on 2026-11-19 through the GitHub API (`/repos/cpsbvbng26-dotcom/verification-hub/private-vulnerability-reporting`).

An exposed secret key or personal contact detail is reported to the same address.
It is taken down before anything else is decided.

The aim is to answer within 7 days.
There is no bounty.
Fixes are recorded in the history of changes, as far as that is safe.
