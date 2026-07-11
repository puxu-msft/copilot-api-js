import type { ImageContentBlock } from "@/lib/content/types"

export function ImageBlock({ block }: { block: ImageContentBlock }) {
  const src = block.source.type === "base64" ? `data:${block.source.media_type};base64,${block.source.data}` : ""
  if (!src) return <div className="mono text-[13px] text-[var(--content-muted)]">[image: {block.source.type}]</div>
  return (
    <img
      src={src}
      alt="content"
      className="max-h-[300px] max-w-full"
    />
  )
}
