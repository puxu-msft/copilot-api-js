// 组装器已下沉后端(single-source, spec §4)；本文件保留同名 re-export，详情页
// ResponseSegment 消费点零改动。扩展的 Responses/Gemini 工具抽取一并生效。
export { accumulateForwardedContent } from "~backend/lib/history/accumulate-response"
