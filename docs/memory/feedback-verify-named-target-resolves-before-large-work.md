---
name: feedback-verify-named-target-resolves-before-large-work
description: 用户命名的目标(如"ui-v4")动大工程前必须先核实它解析到哪个真实产物;凭记忆钩子/命名约定假设导致整套实现做进错误项目(Vue ui/ 而非 React ui-v4/)
metadata:
  type: feedback
---

用户命名一个目标(项目/目录/组件/端点)后,**动手做大工程前先用 `find`/`ls`/`git ls-files` 核实它解析到哪个真实产物**,尤其当这个名字可能有歧义(既像目录名、又像版本标签、又像项目代号)。别凭记忆钩子、docs 里的 plan 命名、或过往约定去假设。

**Why(踩坑实录)**:用户要求「全面增强 **ui-v4** 的 models 页面」。我凭记忆里的 `ui-v4-*` plan 命名 + docs 假设 "ui-v4 就是 `ui/` 这个 Vue/Vuetify 目录",没核实就做了完整实现(spec + 4-phase plan + ~30 commits + subagent audit)全进了 `ui/`(Vue)。用户反复说"ui-v4"和"5173"我都没警觉。直到用户直接质疑"你真的修改了 ui-v4 吗",一条 `find . -type d -iname '*ui-v4*'` 才暴露:**存在独立的 `./ui-v4/` 目录(React 19 + react-router + zustand + tailwind,跑在 5173),是真正的目标**;`ui/`(Vue)是仍在服务的旧 History UI。整套工作做错了项目。

**How to apply**:
- **大工程(新特性/重构/多文件)第一步 = 定位真实目标**:`find . -maxdepth 3 -type d -iname '*<name>*'`、`ls`、`git ls-files | grep`、读 `package.json` 的 name/scripts、看端口(5173=vite dev 哪个 workspace)。一条命令的成本 << 做错整套的成本。
- **名字歧义是强信号**:"ui-v4""v2""new-frontend""dashboard"这类既像目录又像版本/代号的,必查。同一仓库常有多个前端(`ui/` + `ui-v4/`)、多套实现并存。
- **用户重复某个词 + 具体环境线索(端口/URL)** = 校准锚点。用户说"5173""React"时,是在告诉你目标的身份,别当背景噪音。
- 是 [[feedback-multidim-completeness-audit-before-claiming-done]] 的"活路径/目标维度"实例、[[feedback-verify-ui-with-build-not-just-typecheck]] 的前置:先验"改的是不是对的东西",再验"改对了没有"。可复用产物(设计 spec 的 WHAT/WHY、后端共享改动、抽出的纯模块)能跨目标迁移,但框架特定的组件实现是重做成本。
