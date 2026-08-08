# A 组 commit message 绑定裁决

裁决资格：我是未参与甲乙双方原结论的第三方，具备裁决资格。

争议清单：［1］表中 8 个文件的首行字节是否逐字等于所绑定 Git commit 的 subject——裁决态：支持乙方。

| 编号 | 文件 | commit | 逐字节结论 |
|---|---|---|---|
| 1 | `history-retry-commit.txt` | `ea0c0179` | 相等 |
| 2 | `shutdown-pty-commit.txt` | `a61bcbd7` | 相等 |
| 3 | `closeout-verification-commit.txt` | `f6e39031` | 相等 |
| 4 | `merge-master-commit.txt` | `10387efe` | 相等 |
| 5 | `review-fix-commit.txt` | `d59a622c` | 相等 |
| 6 | `post-merge-test-policy-commit.txt` | `0a88e2c8` | 相等 |
| 7 | `scope-post-merge-policy-commit.txt` | `f3c7f9be` | 相等 |
| 8 | `tmp-closeout-project-commit.txt` | `0947b2f0` | 相等 |

总裁决：乙方成立；8 项全部相等，甲方关于 6 项错位的主张不成立。

方法一：在 `HEAD=fe821a703a0107cbb46a0d4909d04362c2df3384` 的指定 worktree 中，用 Python 分别读取每个文件的首行原始字节，并分别取得 `git show -s --format=%s <commit>` 的首行原始字节，8 组直接比较均为 `EQUAL`。

方法二：独立用 `stat -c %s` 测量每个单行文件的总字节数，并用 `git show -s --format=%s <commit> | wc -c` 测量 subject 加换行的输出字节数；8 组依次同为 `55、51、49、60、41、46、43、40` 字节，全部一致。该方法单独只能排除长度不等，不能证明同长度内容相等；它与方法一结论无冲突。
