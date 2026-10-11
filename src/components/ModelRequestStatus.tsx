import { useEffect, useState } from 'react'

/** Elapsed time is observed locally; it is not a fabricated completion percentage. */
export function ModelRequestStatus({ label = 'AI 审查' }: { label?: string }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(
      () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000))),
      1000,
    )
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="model-request-status">
      <p role="status">{label}进行中。正在等待模型响应，可随时取消；已发出的请求可能仍会计费。</p>
      <span role="timer" aria-live="off">
        已用时 {seconds} 秒
      </span>
    </div>
  )
}
